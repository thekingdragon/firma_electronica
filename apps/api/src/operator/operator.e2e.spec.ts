/**
 * Panel de operador: acceso (clave propia, deshabilitado sin ella, rechazo por el túnel), resumen global, alta,
 * desactivación y verificación de firmas. Requiere TEST_DATABASE_URL.
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

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const OP = 'o'.repeat(40);

describe('panel de operador', () => {
  let app: INestApplication;
  let off: INestApplication;
  let pool: Pool;
  let storageDir: string;
  let tenantKey: string;
  let tenantId: string;

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
  const op = { 'X-Operator-Key': OP };

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    storageDir = await mkdtemp(join(tmpdir(), 'fes-op-'));
    const t = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A SAC' });
    tenantKey = t.apiKey;
    tenantId = t.tenant.id;
    app = await makeApp(env({ OPERATOR_KEY: OP }));
    off = await makeApp(env());
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await off?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('sin OPERATOR_KEY configurada el panel no existe (404)', async () => {
    const r = await request(off.getHttpServer()).get('/v1/operator/overview').set(op);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('OPERATOR_DISABLED');
  });

  it('sin clave, con clave errónea o con la clave de una corredora: 401', async () => {
    expect((await http().get('/v1/operator/overview')).status).toBe(401);
    expect((await http().get('/v1/operator/overview').set('X-Operator-Key', 'x'.repeat(40))).status).toBe(401);
    expect((await http().get('/v1/operator/overview').set('X-Operator-Key', tenantKey)).status).toBe(401);
    expect((await http().get('/v1/operator/overview').set('X-Api-Key', tenantKey)).status).toBe(401);
  });

  it('la clave de operador no abre las rutas de una corredora', async () => {
    expect((await http().get('/v1/me').set('X-Api-Key', OP)).status).toBe(401);
  });

  it('por el túnel de Cloudflare se rechaza aunque la clave sea correcta, salvo OPERATOR_ALLOW_REMOTE', async () => {
    const r = await http().get('/v1/operator/overview').set(op).set('CF-Connecting-IP', '203.0.113.9');
    expect(r.status).toBe(404);
    const abierto = await makeApp(env({ OPERATOR_KEY: OP, OPERATOR_ALLOW_REMOTE: 'true' }));
    try {
      const ok = await request(abierto.getHttpServer()).get('/v1/operator/overview').set(op).set('CF-Connecting-IP', '203.0.113.9');
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

  it('crear una corredora devuelve su clave una vez y la clave funciona; entra en la lista', async () => {
    const bad = await http().post('/v1/operator/tenants').set(op).send({ name: '' });
    expect(bad.status).toBe(422);
    const r = await http().post('/v1/operator/tenants').set(op).send({ name: 'B', legalName: 'Corredora B SAC', country: 'pe' });
    expect(r.status).toBe(201);
    expect(r.body.apiKey).toBeTruthy();
    expect((await http().get('/v1/me').set('X-Api-Key', r.body.apiKey)).status).toBe(200);
    const list = await http().get('/v1/operator/tenants').set(op);
    expect(list.body.tenants.map((t: { name: string }) => t.name)).toEqual(['A', 'B']);
    expect(JSON.stringify(list.body)).not.toContain(r.body.apiKey);
  });

  it('desactivar una corredora le quita el acceso; reactivarla se lo devuelve', async () => {
    expect((await http().post(`/v1/operator/tenants/${tenantId}/active`).set(op).send({ active: false })).status).toBe(200);
    expect((await http().get('/v1/me').set('X-Api-Key', tenantKey)).status).toBe(401);
    await http().post(`/v1/operator/tenants/${tenantId}/active`).set(op).send({ active: true });
    expect((await http().get('/v1/me').set('X-Api-Key', tenantKey)).status).toBe(200);
    const nope = await http().post('/v1/operator/tenants/00000000-0000-4000-8000-000000000000/active').set(op).send({ active: true });
    expect(nope.status).toBe(404);
  });

  it('verificar una corredora sin firmas da 0; con id inexistente, 404', async () => {
    const r = await http().post(`/v1/operator/tenants/${tenantId}/verify`).set(op);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ checked: 0, ok: 0, failed: [] });
    expect((await http().post('/v1/operator/tenants/00000000-0000-4000-8000-000000000000/verify').set(op)).status).toBe(404);
  });
});
