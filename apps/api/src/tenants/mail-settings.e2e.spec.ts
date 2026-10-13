/**
 * Correo propio de la corredora desde el panel: se configura, se prueba, nunca devuelve la contraseña y no se puede usar
 * como puente hacia la red interna. Requiere TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { hashPassword } from '../auth/passwords';
import { insertUser } from '../auth/users.service';
import { makeApp, resetDatabase, startSmtp, testDatabaseUrl } from '../test-utils';
import { createTenant } from './tenants.service';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const PASS = 'Contrasena-Segura-123';
const SECRETO_SMTP = 'clave-del-correo-que-no-debe-salir-nunca';

describe('correo de la corredora desde el panel', () => {
  let app: INestApplication;
  let appEstricta: INestApplication;
  let pool: Pool;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  let storageDir: string;
  let admin: string;
  let revisor: string;
  let adminB: string;

  const http = (a: INestApplication = app) => request(a.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const env = (extra: Record<string, string> = {}) => ({ DATABASE_URL: URL_DB, TOKEN_SECRET: 't'.repeat(40), PUBLIC_BASE_URL: 'https://firma.test', NODE_ENV: 'test', SECRETS_KEY: KEY_B64, STORAGE_DIR: storageDir, ...extra });

  async function sesion(role: 'ADMIN' | 'REVIEWER', email: string, tenant: string) {
    const u = await insertUser(pool, { tenantId: tenant, email, name: email, role });
    await pool.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, await hashPassword(PASS)]);
    return (await http().post('/v1/auth/login').send({ email, password: PASS })).body.accessToken as string;
  }
  const valido = () => ({ host: '127.0.0.1', port: smtp.port, secure: false, fromEmail: 'avisos@a.test', fromName: 'Corredora A' });

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    smtp = await startSmtp();
    storageDir = await mkdtemp(join(tmpdir(), 'fes-mailset-'));
    const a = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'A SAC' });
    const b = await createTenant(pool, { name: 'B', country: 'PE', legalName: 'B SAC' });
    // La prueba levanta su SMTP en 127.0.0.1: con direcciones privadas permitidas. La instancia estricta es la de producción.
    app = await makeApp(env({ WEBHOOK_ALLOW_PRIVATE: 'true' }));
    appEstricta = await makeApp(env());
    admin = await sesion('ADMIN', 'admin@a.test', a.tenant.id);
    revisor = await sesion('REVIEWER', 'revisor@a.test', a.tenant.id);
    adminB = await sesion('ADMIN', 'admin@b.test', b.tenant.id);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await appEstricta?.close();
    await smtp?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('sin configurar: lo dice, sin inventar valores', async () => {
    const r = await http().get('/v1/settings/mail').set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: false, host: null, hasPassword: false, verifiedAt: null });
  });

  it('solo el administrador: el revisor no ve ni cambia el correo', async () => {
    expect((await http().get('/v1/settings/mail').set(bearer(revisor))).status).toBe(403);
    expect((await http().put('/v1/settings/mail').set(bearer(revisor)).send(valido())).status).toBe(403);
    expect((await http().post('/v1/settings/mail/test').set(bearer(revisor)).send({ to: 'x@y.com' })).status).toBe(403);
  });

  it('valida: servidor con https://, puerto fuera de rango, correo mal escrito, campos de más', async () => {
    for (const mala of [{ host: 'https://smtp.gmail.com' }, { host: 'smtp gmail.com' }, { port: 0 }, { port: 70000 }, { port: '587' }, { fromEmail: 'no-es-correo' }, { replyTo: 'tampoco' }, { otro: 1 }]) {
      const r = await http().put('/v1/settings/mail').set(bearer(admin)).send({ ...valido(), ...mala });
      expect(r.status).toBe(422);
    }
    expect((await http().get('/v1/settings/mail').set(bearer(admin))).body.configured).toBe(false);
  });

  it('con usuario hay que dar la contraseña la primera vez', async () => {
    const r = await http().put('/v1/settings/mail').set(bearer(admin)).send({ ...valido(), username: 'avisos@a.test' });
    expect(r.status).toBe(422);
    expect(r.body.issues[0].path).toBe('password');
  });

  it('se guarda cifrada y NUNCA se devuelve: ni en la respuesta ni en la base en claro', async () => {
    const r = await http().put('/v1/settings/mail').set(bearer(admin)).send({ ...valido(), username: 'avisos@a.test', password: SECRETO_SMTP });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, host: '127.0.0.1', username: 'avisos@a.test', hasPassword: true, verifiedAt: null });
    expect(JSON.stringify(r.body)).not.toContain(SECRETO_SMTP);
    expect(JSON.stringify((await http().get('/v1/settings/mail').set(bearer(admin))).body)).not.toContain(SECRETO_SMTP);
    const fila = (await pool.query('SELECT password_enc FROM tenant_mail_settings')).rows[0];
    expect(fila.password_enc).toBeTruthy();
    expect(fila.password_enc).not.toContain(SECRETO_SMTP);
  });

  it('cambiar el remitente sin mandar la contraseña conserva la guardada; y deja de estar verificado', async () => {
    await pool.query('UPDATE tenant_mail_settings SET verified_at = now()');
    const antes = (await pool.query('SELECT password_enc FROM tenant_mail_settings')).rows[0].password_enc;
    const r = await http().put('/v1/settings/mail').set(bearer(admin)).send({ ...valido(), username: 'avisos@a.test', fromName: 'Otro nombre' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fromName: 'Otro nombre', hasPassword: true, verifiedAt: null });
    expect((await pool.query('SELECT password_enc FROM tenant_mail_settings')).rows[0].password_enc).toBe(antes);
  });

  it('el correo de prueba sale por el servidor configurado y deja la configuración verificada', async () => {
    const antes = smtp.mails.length;
    const r = await http().post('/v1/settings/mail/test').set(bearer(admin)).send({ to: 'yo@correo.test' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(smtp.mails.length).toBe(antes + 1);
    expect(smtp.mails[antes].to).toContain('yo@correo.test');
    // El asunto llega codificado (MIME) por llevar tilde; el cuerpo basta para saber que es el de la prueba.
    expect(smtp.mails[antes].text).toContain('está bien configurado');
    expect(smtp.mails[antes].from.address).toBe('avisos@a.test');
    const v = (await http().get('/v1/settings/mail').set(bearer(admin))).body;
    expect(v.verifiedAt).toBeTruthy();
    expect(v.lastError).toBeNull();
  });

  it('si el servidor falla, la respuesta explica qué hacer (no el error crudo) y queda anotado', async () => {
    await http().put('/v1/settings/mail').set(bearer(admin)).send({ ...valido(), port: 1, username: 'avisos@a.test' });
    const r = await http().post('/v1/settings/mail/test').set(bearer(admin)).send({ to: 'yo@correo.test' });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('MAIL_SEND_FAILED');
    expect(r.body.message.length).toBeGreaterThan(20);
    expect((await http().get('/v1/settings/mail').set(bearer(admin))).body.lastError).toBeTruthy();
    await http().put('/v1/settings/mail').set(bearer(admin)).send({ ...valido(), username: 'avisos@a.test' });
  });

  it('probar sin haber configurado nada: 409; correo de destino inválido: 422', async () => {
    expect((await http().post('/v1/settings/mail/test').set(bearer(adminB)).send({ to: 'x@y.com' })).status).toBe(409);
    expect((await http().post('/v1/settings/mail/test').set(bearer(admin)).send({ to: 'no' })).status).toBe(422);
  });

  it('cada corredora ve solo lo suyo', async () => {
    expect((await http().get('/v1/settings/mail').set(bearer(adminB))).body.configured).toBe(false);
    expect((await http().get('/v1/settings/mail').set(bearer(admin))).body.configured).toBe(true);
  });

  it('en producción (sin permitir direcciones privadas) no se puede apuntar a la red interna', async () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.169.254', 'localhost']) {
      const r = await http(appEstricta).put('/v1/settings/mail').set(bearer(admin)).send({ ...valido(), host });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('MAIL_HOST_NOT_ALLOWED');
    }
    const noExiste = await http(appEstricta).put('/v1/settings/mail').set(bearer(admin)).send({ ...valido(), host: 'servidor-que-no-existe.invalid' });
    expect(noExiste.status).toBe(422);
  });
});
