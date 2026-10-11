/**
 * Panel de operador: acceso (sesión con rol OPERATOR y segundo factor; rechazo por el túnel), resumen global, alta con su
 * primer administrador, desactivación y verificación de firmas. Requiere TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { hashPassword } from '../auth/passwords';
import { base32Decode, hotp, stepFor } from '../auth/totp';
import { insertUser } from '../auth/users.service';
import { createTenant } from '../tenants/tenants.service';
import { makeApp, resetDatabase, testDatabaseUrl } from '../test-utils';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const PASS = 'Contrasena-Segura-123';

describe('panel de operador', () => {
  let app: INestApplication;
  let pool: Pool;
  let storageDir: string;
  let tenantKey: string;
  let tenantId: string;
  let op: { Authorization: string };

  const env = (extra: Record<string, string> = {}) => ({
    DATABASE_URL: URL_DB,
    TOKEN_SECRET: 't'.repeat(40),
    PUBLIC_BASE_URL: 'https://firma.test',
    NODE_ENV: 'test',
    SECRETS_KEY: KEY_B64,
    STORAGE_DIR: storageDir,
    ALLOW_DEV_OTP: 'true',
    ...extra,
  });
  const http = () => request(app.getHttpServer());

  /** Crea un operador, activa su segundo factor por el camino real (testigo intermedio) y devuelve su sesión. */
  async function operador(server: INestApplication, email: string, headers: Record<string, string> = {}) {
    const u = await insertUser(pool, { tenantId: null, email, name: 'Operador', role: 'OPERATOR' });
    await pool.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, await hashPassword(PASS)]);
    const api = () => request(server.getHttpServer());
    let r = api().post('/v1/auth/login');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    const login = await r.send({ email, password: PASS });
    if (login.body.status !== 'mfa_setup_required') return { login, token: null as string | null };
    const pending = login.body.pendingToken as string;
    const setup = await api().post('/v1/auth/mfa/setup-pending').send({ pendingToken: pending });
    const code = hotp(base32Decode(setup.body.secret), stepFor());
    const en = await api().post('/v1/auth/mfa/enable-pending').send({ pendingToken: pending, code });
    return { login, token: en.body.accessToken as string };
  }

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    storageDir = await mkdtemp(join(tmpdir(), 'fes-op-'));
    const t = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A SAC' });
    tenantKey = t.apiKey;
    tenantId = t.tenant.id;
    app = await makeApp(env());
    const o = await operador(app, 'op@plataforma.test');
    op = { Authorization: `Bearer ${o.token}` };
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('sin sesión o con basura: 401', async () => {
    expect((await http().get('/v1/operator/overview')).status).toBe(401);
    expect((await http().get('/v1/operator/overview').set('Authorization', 'Bearer basura')).status).toBe(401);
  });

  it('la clave de API de una corredora no abre el panel, ni la sesión de operador abre las rutas de una corredora', async () => {
    expect((await http().get('/v1/operator/overview').set('X-Api-Key', tenantKey)).status).toBe(401);
    expect((await http().get('/v1/requests').set(op)).status).toBe(403);
  });

  it('por el túnel de Cloudflare no entra el operador, aunque la sesión sea buena, salvo OPERATOR_ALLOW_REMOTE', async () => {
    const r = await http().get('/v1/operator/overview').set(op).set('CF-Connecting-IP', '203.0.113.9');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('OPERATOR_DISABLED');
    // Ni siquiera el login: se responde como si la cuenta no existiera.
    const login = await http().post('/v1/auth/login').set('CF-Connecting-IP', '203.0.113.9').send({ email: 'op@plataforma.test', password: PASS });
    expect(login.status).toBe(401);

    const abierto = await makeApp(env({ OPERATOR_ALLOW_REMOTE: 'true' }));
    try {
      const o = await operador(abierto, 'op-remoto@plataforma.test', { 'CF-Connecting-IP': '203.0.113.9' });
      expect(o.token).toBeTruthy();
      const ok = await request(abierto.getHttpServer()).get('/v1/operator/overview').set('Authorization', `Bearer ${o.token}`).set('CF-Connecting-IP', '203.0.113.9');
      expect(ok.status).toBe(200);
    } finally {
      await abierto.close();
    }
  });

  it('el resumen trae el estado del servicio y los totales', async () => {
    const r = await http().get('/v1/operator/overview').set(op);
    expect(r.status).toBe(200);
    expect(r.body.service).toMatchObject({ database: true, storageWritable: true, secretsKey: true, timestampAuthority: false });
    expect(r.body.totals).toMatchObject({ tenants: 1, activeTenants: 1, signedLast30Days: 0, webhooksFailed: 0 });
  });

  it('crear una corredora con su administrador: la clave y la contraseña provisional se devuelven una vez', async () => {
    const bad = await http().post('/v1/operator/tenants').set(op).send({ name: '' });
    expect(bad.status).toBe(422);
    const r = await http().post('/v1/operator/tenants').set(op).send({ name: 'B', legalName: 'Corredora B SAC', country: 'pe', adminEmail: 'dueno@b.test', adminName: 'Dueña de B' });
    expect(r.status).toBe(201);
    expect((await http().get('/v1/me').set('X-Api-Key', r.body.apiKey)).status).toBe(200);
    expect(r.body.admin.email).toBe('dueno@b.test');
    // La persona entra con la provisional y está obligada a cambiarla.
    const login = await http().post('/v1/auth/login').send({ email: 'dueno@b.test', password: r.body.admin.temporaryPassword });
    expect(login.body).toMatchObject({ status: 'ok', user: { role: 'ADMIN', mustChangePassword: true }, tenant: { name: 'B' } });
    const list = await http().get('/v1/operator/tenants').set(op);
    expect(list.body.tenants.map((t: { name: string }) => t.name)).toEqual(['A', 'B']);
    expect(JSON.stringify(list.body)).not.toContain(r.body.apiKey);
    expect(JSON.stringify(list.body)).not.toContain(r.body.admin.temporaryPassword);
    // Un correo ya usado no crea una corredora a medias.
    const dup = await http().post('/v1/operator/tenants').set(op).send({ name: 'C', legalName: 'C SAC', country: 'PE', adminEmail: 'DUENO@b.test' });
    expect(dup.status).toBe(409);
    expect((await http().get('/v1/operator/tenants').set(op)).body.tenants).toHaveLength(2);
  });

  it('agregar un administrador a una corredora que se quedó sin acceso', async () => {
    const r = await http().post(`/v1/operator/tenants/${tenantId}/admin`).set(op).send({ email: 'rescate@a.test', name: 'Rescate' });
    expect(r.status).toBe(201);
    const login = await http().post('/v1/auth/login').send({ email: 'rescate@a.test', password: r.body.temporaryPassword });
    expect(login.body.user).toMatchObject({ role: 'ADMIN', mustChangePassword: true });
    expect((await http().post('/v1/operator/tenants/00000000-0000-4000-8000-000000000000/admin').set(op).send({ email: 'x@x.test', name: 'X' })).status).toBe(404);
  });

  it('desactivar una corredora corta a sus usuarios y su clave; reactivarla se los devuelve', async () => {
    const alta = await http().post(`/v1/operator/tenants/${tenantId}/admin`).set(op).send({ email: 'activo@a.test', name: 'Activo' });
    const sesion = await http().post('/v1/auth/login').send({ email: 'activo@a.test', password: alta.body.temporaryPassword });
    expect(sesion.status).toBe(200);
    const token = { Authorization: `Bearer ${sesion.body.accessToken}` };
    expect((await http().get('/v1/auth/me').set(token)).status).toBe(200);

    expect((await http().post(`/v1/operator/tenants/${tenantId}/active`).set(op).send({ active: false })).status).toBe(200);
    expect((await http().get('/v1/me').set('X-Api-Key', tenantKey)).status).toBe(401);
    expect((await http().get('/v1/auth/me').set(token)).status).toBe(401);
    expect((await http().post('/v1/auth/login').send({ email: 'activo@a.test', password: alta.body.temporaryPassword })).status).toBe(401);

    await http().post(`/v1/operator/tenants/${tenantId}/active`).set(op).send({ active: true });
    expect((await http().get('/v1/me').set('X-Api-Key', tenantKey)).status).toBe(200);
    expect((await http().post('/v1/auth/login').send({ email: 'activo@a.test', password: alta.body.temporaryPassword })).status).toBe(200);
    expect((await http().post('/v1/operator/tenants/00000000-0000-4000-8000-000000000000/active').set(op).send({ active: true })).status).toBe(404);
  });

  it('verificar una corredora sin firmas da 0; con id inexistente, 404', async () => {
    const r = await http().post(`/v1/operator/tenants/${tenantId}/verify`).set(op);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ checked: 0, ok: 0, failed: [] });
    expect((await http().post('/v1/operator/tenants/00000000-0000-4000-8000-000000000000/verify').set(op)).status).toBe(404);
  });
});
