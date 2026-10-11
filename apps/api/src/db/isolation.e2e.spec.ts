/**
 * Aislamiento entre corredoras en la BASE DE DATOS (RLS), independiente de que el código filtre por tenant_id.
 * Se prueba con una conexión REAL del rol de runtime (firma_runtime), el mismo con que corre la aplicación.
 * Requiere TEST_DATABASE_URL.
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
import { DB_ISOLATION, DbIsolationService, PG_POOL } from './db.module';
import { withTenant } from './tenant-context';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');

/** SQLSTATE 42501 (insufficient_privilege): lo da tanto una política RLS violada como un permiso de tabla negado. No depende del idioma del servidor. */
const DENEGADO = '42501';

describe('aislamiento entre corredoras (RLS)', () => {
  let app: INestApplication;
  let owner: Pool;
  let runtime: Pool;
  let storageDir: string;
  let keyA: string;
  let keyB: string;
  let tenantA: string;
  let tenantB: string;
  let reqA: string;
  let reqB: string;

  const http = () => request(app.getHttpServer());

  /** Una conexión del rol de runtime con la corredora fijada (o ninguna). */
  async function como<T>(tenant: string | null, fn: (q: Pool) => Promise<T>): Promise<T> {
    const client = await runtime.connect();
    try {
      await client.query("SELECT set_config('app.current_tenant', $1, false)", [tenant ?? '']);
      return await fn(client as unknown as Pool);
    } finally {
      client.release();
    }
  }

  async function crear(key: string, ref: string) {
    const r = await http()
      .post('/v1/requests')
      .set('X-Api-Key', key)
      .send({
        documentType: 'APPOINTMENT_LETTER',
        externalRef: ref,
        signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
        data: { insurances: ['SCTR'] },
        otp: { channel: 'EMAIL', to: 'ana@example.com' },
        delivery: { mode: 'HOST' },
      });
    expect(r.status).toBe(201);
    return { id: r.body.id as string, token: (r.body.signUrl as string).split('/s/')[1] };
  }

  beforeAll(async () => {
    owner = await resetDatabase(URL_DB);
    const u = new URL(URL_DB);
    u.username = 'firma_runtime';
    u.password = '';
    runtime = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL ?? u.toString() });
    const a = await createTenant(owner, { name: 'A', country: 'PE', legalName: 'Corredora A SAC' });
    const b = await createTenant(owner, { name: 'B', country: 'PE', legalName: 'Corredora B SAC' });
    keyA = a.apiKey;
    keyB = b.apiKey;
    tenantA = a.tenant.id;
    tenantB = b.tenant.id;
    storageDir = await mkdtemp(join(tmpdir(), 'fes-rls-'));
    app = await makeApp({
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      SECRETS_KEY: KEY_B64,
      STORAGE_DIR: storageDir,
      ALLOW_DEV_OTP: 'true',
    });
    reqA = (await crear(keyA, 'a-1')).id;
    reqB = (await crear(keyB, 'b-1')).id;
    await owner.query("INSERT INTO access_log (request_id, event) VALUES ($1, 'link_opened'), ($2, 'link_opened')", [reqA, reqB]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.end();
    await owner?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  describe('el rol de runtime, directo contra la base', () => {
    it('sin corredora fijada no ve NADA, aunque las filas existan', async () => {
      expect(Number((await owner.query('SELECT count(*) FROM signature_requests')).rows[0].count)).toBe(2);
      for (const tabla of ['signature_requests', 'tenants', 'document_templates', 'access_log', 'signature_evidence']) {
        const n = await como(null, async (q) => Number((await q.query(`SELECT count(*) FROM ${tabla}`)).rows[0].count));
        expect(n).toBe(0);
      }
    });

    it('con una corredora fijada ve solo lo suyo, en las tablas directas y en las que cuelgan de una solicitud', async () => {
      const ids = await como(tenantA, async (q) => (await q.query('SELECT id FROM signature_requests')).rows.map((r) => r.id));
      expect(ids).toEqual([reqA]);
      expect(await como(tenantA, async (q) => (await q.query('SELECT id FROM tenants')).rows.map((r) => r.id))).toEqual([tenantA]);
      const templates = await como(tenantB, async (q) => (await q.query('SELECT DISTINCT tenant_id FROM document_templates')).rows.map((r) => r.tenant_id));
      expect(templates).toEqual([tenantB]);
      const log = await como(tenantA, async (q) => (await q.query('SELECT DISTINCT request_id FROM access_log')).rows.map((r) => r.request_id));
      expect(log).toEqual([reqA]);
    });

    it('no puede escribir en otra corredora: ni insertar, ni modificar, ni mover una fila a otra', async () => {
      // Insertar una solicitud de B estando como A: lo rechaza WITH CHECK.
      await expect(
        como(tenantA, (q) => q.query(`UPDATE signature_requests SET tenant_id = $1 WHERE id = $2`, [tenantB, reqA])),
      ).rejects.toMatchObject({ code: DENEGADO });
      // Modificar una fila de B estando como A: no la ve, así que no toca ninguna.
      const r = await como(tenantA, (q) => q.query(`UPDATE signature_requests SET reference = 'HACK' WHERE id = $1`, [reqB]));
      expect(r.rowCount).toBe(0);
      expect((await owner.query('SELECT reference FROM signature_requests WHERE id = $1', [reqB])).rows[0].reference).not.toBe('HACK');
      // Registrar un evento de la solicitud de B estando como A.
      await expect(como(tenantA, (q) => q.query(`INSERT INTO access_log (request_id, event) VALUES ($1, 'link_opened')`, [reqB]))).rejects.toMatchObject({ code: DENEGADO });
      // Y al revés, una fila propia sí.
      await como(tenantA, (q) => q.query(`INSERT INTO access_log (request_id, event) VALUES ($1, 'link_opened')`, [reqA]));
    });

    it('no toca las tablas de usuarios y sesiones: ni siquiera con corredora fijada', async () => {
      for (const tabla of ['users', 'refresh_tokens', 'mfa_recovery_codes', 'password_resets', 'schema_migrations']) {
        await expect(como(tenantA, (q) => q.query(`SELECT 1 FROM ${tabla} LIMIT 1`))).rejects.toMatchObject({ code: DENEGADO });
      }
    });

    it('la bitácora es solo de adición también a nivel de permisos', async () => {
      await expect(como(tenantA, (q) => q.query('DELETE FROM access_log'))).rejects.toMatchObject({ code: DENEGADO });
      await expect(como(tenantA, (q) => q.query("UPDATE access_log SET event = 'x'"))).rejects.toMatchObject({ code: DENEGADO });
    });

    it('no es superusuario ni se salta RLS', async () => {
      const r = await como(null, async (q) => (await q.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0]);
      expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });

  describe('la aplicación', () => {
    it('detecta que el runtime está sujeto a RLS', () => {
      expect(app.get<DbIsolationService>(DB_ISOLATION).state).toEqual({ rlsEnforced: true, reason: null });
    });

    it('un «olvidé el WHERE tenant_id» no filtra datos: la consulta sin filtro solo devuelve lo de la corredora del contexto', async () => {
      const pool = app.get<Pool>(PG_POOL);
      const sinFiltro = 'SELECT id FROM signature_requests';
      expect((await withTenant(tenantA, () => pool.query(sinFiltro))).rows.map((r) => r.id)).toEqual([reqA]);
      expect((await withTenant(tenantB, () => pool.query(sinFiltro))).rows.map((r) => r.id)).toEqual([reqB]);
      // Sin contexto (p. ej. una tarea que olvidó fijarlo) falla cerrado.
      expect((await pool.query(sinFiltro)).rows).toEqual([]);
    });

    it('las conexiones no arrastran la corredora de la petición anterior', async () => {
      const pool = app.get<Pool>(PG_POOL);
      for (let i = 0; i < 12; i++) {
        const t = i % 2 === 0 ? tenantA : tenantB;
        const rows = (await withTenant(t, () => pool.query('SELECT DISTINCT tenant_id FROM signature_requests'))).rows;
        expect(rows.map((r) => r.tenant_id)).toEqual([t]);
        expect((await pool.query('SELECT 1 FROM signature_requests LIMIT 1')).rowCount).toBe(0);
      }
    });

    it('cada clave de API ve solo lo suyo, y la solicitud de otra corredora es un 404', async () => {
      const a = await http().get('/v1/requests').set('X-Api-Key', keyA);
      expect(a.body.items.map((i: { id: string }) => i.id)).toEqual([reqA]);
      expect((await http().get(`/v1/requests/${reqB}`).set('X-Api-Key', keyA)).status).toBe(404);
      expect((await http().get(`/v1/requests/${reqB}/evidence`).set('X-Api-Key', keyA)).status).toBe(404);
    });

    it('el enlace público de una corredora abre su documento (el contexto sale del token)', async () => {
      const { token } = await crear(keyB, 'b-2');
      const r = await http().get(`/v1/sign/${token}`);
      expect(r.status).toBe(200);
      expect((await http().get(`/v1/sign/${'x'.repeat(43)}`)).status).toBe(404);
    });

    it('con sesión: el usuario de una corredora no ve lo de otra', async () => {
      const u = await insertUser(owner, { tenantId: tenantA, email: 'admin@a.test', name: 'Admin A', role: 'ADMIN' });
      await owner.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, await hashPassword('Contrasena-Segura-123')]);
      const login = await http().post('/v1/auth/login').send({ email: 'admin@a.test', password: 'Contrasena-Segura-123' });
      const bearer = { Authorization: `Bearer ${login.body.accessToken}` };
      const lista = await http().get('/v1/requests').set(bearer);
      expect(lista.body.items.map((i: { id: string }) => i.id)).toContain(reqA);
      expect(lista.body.items.map((i: { id: string }) => i.id)).not.toContain(reqB);
      expect((await http().get(`/v1/requests/${reqB}`).set(bearer)).status).toBe(404);
    });

    it('el panel de operador informa si el aislamiento está activo', async () => {
      const u = await insertUser(owner, { tenantId: null, email: 'op@plataforma.test', name: 'Op', role: 'OPERATOR' });
      await owner.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, await hashPassword('Contrasena-Segura-123')]);
      const login = await http().post('/v1/auth/login').send({ email: 'op@plataforma.test', password: 'Contrasena-Segura-123' });
      const setup = await http().post('/v1/auth/mfa/setup-pending').send({ pendingToken: login.body.pendingToken });
      const en = await http().post('/v1/auth/mfa/enable-pending').send({ pendingToken: login.body.pendingToken, code: hotp(base32Decode(setup.body.secret), stepFor()) });
      const r = await http().get('/v1/operator/overview').set({ Authorization: `Bearer ${en.body.accessToken}` });
      expect(r.body.service).toMatchObject({ rlsEnforced: true, rlsReason: null });
    });
  });
});
