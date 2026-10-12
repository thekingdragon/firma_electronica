/**
 * Bitácora de accesos: quién entró, quién falló, quién cambió qué y desde dónde; solo de adición y solo para el dueño.
 * Requiere TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { createTenant } from '../tenants/tenants.service';
import { makeApp, resetDatabase, testDatabaseUrl } from '../test-utils';
import { hashPassword } from './passwords';
import { base32Decode, hotp, stepFor } from './totp';
import { insertUser } from './users.service';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const PASS = 'Contrasena-Segura-123';

describe('bitácora de accesos', () => {
  let app: INestApplication;
  let pool: Pool;
  let storageDir: string;
  let tenantA: string;
  let tenantB: string;

  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const eventos = async (where = 'true', params: unknown[] = []) => (await pool.query(`SELECT * FROM auth_events WHERE ${where} ORDER BY id`, params)).rows;

  async function usuario(role: 'ADMIN' | 'REVIEWER' | 'OPERATOR', email: string, tenant: string | null) {
    const u = await insertUser(pool, { tenantId: role === 'OPERATOR' ? null : tenant, email, name: `Usuario ${email}`, role });
    await pool.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, await hashPassword(PASS)]);
    return u.id;
  }
  const login = (email: string, password = PASS) => http().post('/v1/auth/login').set('User-Agent', 'PruebaNavegador/1.0').send({ email, password });

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    tenantA = (await createTenant(pool, { name: 'A', country: 'PE', legalName: 'A SAC' })).tenant.id;
    tenantB = (await createTenant(pool, { name: 'B', country: 'PE', legalName: 'B SAC' })).tenant.id;
    storageDir = await mkdtemp(join(tmpdir(), 'fes-ev-'));
    app = await makeApp({ DATABASE_URL: URL_DB, TOKEN_SECRET: 't'.repeat(40), PUBLIC_BASE_URL: 'https://firma.test', NODE_ENV: 'test', SECRETS_KEY: KEY_B64, STORAGE_DIR: storageDir });
    await usuario('ADMIN', 'admin@a.test', tenantA);
    await usuario('REVIEWER', 'revisor@a.test', tenantA);
    await usuario('ADMIN', 'admin@b.test', tenantB);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('un inicio de sesión correcto queda con la persona, su corredora, la IP y el navegador', async () => {
    expect((await login('ADMIN@a.test')).status).toBe(200);
    const [e] = await eventos("event = 'login_ok' AND email = 'admin@a.test'");
    expect(e).toMatchObject({ event: 'login_ok', email: 'admin@a.test', tenant_id: tenantA, user_agent: 'PruebaNavegador/1.0' });
    expect(e.user_id).toBeTruthy();
    expect(e.ip).toBeTruthy();
    expect(e.detail).toEqual({ mfa: false });
  });

  it('un intento fallido queda registrado, también contra un correo que no existe (sin delatar nada en la respuesta)', async () => {
    expect((await login('admin@a.test', 'mala-contrasena-1')).status).toBe(401);
    expect((await login('Fantasma@Ejemplo.COM', 'mala-contrasena-1')).status).toBe(401);
    const [mala] = await eventos("event = 'login_failed' AND detail->>'reason' = 'password'");
    expect(mala.email).toBe('admin@a.test');
    const [fantasma] = await eventos("event = 'login_failed' AND detail->>'reason' = 'unknown_or_inactive'");
    expect(fantasma).toMatchObject({ email: 'fantasma@ejemplo.com', user_id: null, tenant_id: null });
  });

  it('la contraseña nunca se guarda en la bitácora', async () => {
    await login('admin@a.test', 'otra-contrasena-que-no-debe-guardarse-9');
    const todo = JSON.stringify(await eventos());
    expect(todo).not.toContain('otra-contrasena-que-no-debe-guardarse-9');
    expect(todo).not.toContain(PASS);
  });

  it('las acciones de administración quedan con quién las hizo', async () => {
    const admin = (await login('admin@a.test')).body.accessToken as string;
    const adminId = (await pool.query("SELECT id FROM users WHERE email = 'admin@a.test'")).rows[0].id;
    const creado = await http().post('/v1/users').set(bearer(admin)).send({ email: 'nuevo@a.test', name: 'Nuevo', role: 'REVIEWER' });
    expect(creado.status).toBe(201);
    expect((await http().patch(`/v1/users/${creado.body.id}`).set(bearer(admin)).send({ role: 'ADMIN' })).status).toBe(204);
    expect((await http().post(`/v1/users/${creado.body.id}/reset-password`).set(bearer(admin))).status).toBe(200);
    const hechas = await eventos('user_id = $1 AND actor_id = $2', [creado.body.id, adminId]);
    expect(hechas.map((e) => e.event)).toEqual(['user_created', 'user_updated', 'password_reset_by_admin']);
    expect(hechas[1].detail).toEqual({ role: { from: 'REVIEWER', to: 'ADMIN' } });
    expect(hechas.every((e) => e.tenant_id === tenantA)).toBe(true);
  });

  it('cambiar la contraseña y salir quedan registrados', async () => {
    await usuario('REVIEWER', 'cambia@a.test', tenantA);
    const s = await login('cambia@a.test');
    const cookie = ((s.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token=')) as string).split(';')[0];
    const ch = await http().post('/v1/auth/password/change').set(bearer(s.body.accessToken)).send({ currentPassword: PASS, newPassword: 'Otra-Contrasena-456' });
    expect(ch.status).toBe(200);
    const nueva = ((ch.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token=')) as string).split(';')[0];
    await http().post('/v1/auth/logout').set('Cookie', nueva);
    expect(cookie).toBeTruthy();
    const ev = (await eventos("email = 'cambia@a.test'")).map((e) => e.event);
    expect(ev).toEqual(expect.arrayContaining(['login_ok', 'password_changed', 'logout']));
  });

  it('el segundo factor: activar, fallar y entrar con el código quedan registrados', async () => {
    const id = await usuario('ADMIN', 'mfa@a.test', tenantA);
    const s = await login('mfa@a.test');
    const token = s.body.accessToken as string;
    const setup = await http().post('/v1/auth/mfa/setup').set(bearer(token));
    const secret = setup.body.secret as string;
    expect((await http().post('/v1/auth/mfa/enable').set(bearer(token)).send({ code: hotp(base32Decode(secret), stepFor()) })).status).toBe(200);
    const pend = (await login('mfa@a.test')).body.pendingToken as string;
    expect((await http().post('/v1/auth/mfa/verify').send({ pendingToken: pend, code: '000000' })).status).toBe(401);
    const ev = (await eventos('user_id = $1', [id])).map((e) => e.event);
    expect(ev).toEqual(expect.arrayContaining(['mfa_enabled', 'mfa_failed']));
  });

  it('el administrador ve solo los eventos de SU corredora; el revisor no ve ninguno', async () => {
    const a = (await login('admin@a.test')).body.accessToken as string;
    const b = (await login('admin@b.test')).body.accessToken as string;
    const deA = (await http().get('/v1/users/events').set(bearer(a))).body.events as { tenantName: string | null }[];
    const deB = (await http().get('/v1/users/events').set(bearer(b))).body.events as { tenantName: string | null }[];
    expect(deA.length).toBeGreaterThan(3);
    expect(deA.every((e) => e.tenantName === 'A')).toBe(true);
    expect(deB.every((e) => e.tenantName === 'B')).toBe(true);
    expect(JSON.stringify(deB)).not.toContain('admin@a.test');
    const rev = (await login('revisor@a.test')).body.accessToken as string;
    expect((await http().get('/v1/users/events').set(bearer(rev))).status).toBe(403);
  });

  it('es solo de adición: ni el dueño puede modificarla o borrarla', async () => {
    await expect(pool.query("UPDATE auth_events SET event = 'x'")).rejects.toThrow(/solo de adici/i);
    await expect(pool.query('DELETE FROM auth_events')).rejects.toThrow(/solo de adici/i);
  });

  it('el runtime de las corredoras no puede ni leerla', async () => {
    const u = new URL(URL_DB);
    u.username = 'firma_runtime';
    u.password = '';
    const rt = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL ?? u.toString() });
    try {
      await expect(rt.query('SELECT 1 FROM auth_events LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rt.end();
    }
  });

  it('el operador ve los eventos de todas las corredoras, incluidas sus propias acciones', async () => {
    await usuario('OPERATOR', 'op@plataforma.test', null);
    const l = await login('op@plataforma.test');
    const setup = await http().post('/v1/auth/mfa/setup-pending').send({ pendingToken: l.body.pendingToken });
    const en = await http().post('/v1/auth/mfa/enable-pending').send({ pendingToken: l.body.pendingToken, code: hotp(base32Decode(setup.body.secret), stepFor()) });
    const op = bearer(en.body.accessToken);
    const t = await http().post('/v1/operator/tenants').set(op).send({ name: 'C', legalName: 'C SAC', country: 'PE', adminEmail: 'dueno@c.test', adminName: 'Dueña' });
    expect(t.status).toBe(201);
    await http().post(`/v1/operator/tenants/${t.body.tenant.id}/active`).set(op).send({ active: false });
    const todos = (await http().get('/v1/operator/auth-events').set(op)).body.events as { event: string; actorName: string | null }[];
    const acciones = todos.filter((e) => ['tenant_created', 'admin_added', 'tenant_active_changed'].includes(e.event));
    expect(acciones.map((e) => e.event)).toEqual(expect.arrayContaining(['tenant_created', 'admin_added', 'tenant_active_changed']));
    expect(acciones.every((e) => e.actorName === 'Usuario op@plataforma.test')).toBe(true);
    const soloA = (await http().get(`/v1/operator/auth-events?tenantId=${tenantA}`).set(op)).body.events as { tenantName: string }[];
    expect(soloA.length).toBeGreaterThan(0);
    expect(soloA.every((e) => e.tenantName === 'A')).toBe(true);
    // El panel de una corredora no abre esto.
    const a = (await login('admin@a.test')).body.accessToken as string;
    expect((await http().get('/v1/operator/auth-events').set(bearer(a))).status).toBe(403);
  });
});
