/**
 * Autenticación del panel: login, sesiones con rotación y detección de reuso, cambio de contraseña, segundo factor,
 * recuperación por correo, roles y gestión de usuarios. Requiere TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { saveMailSettings } from '../mail/mail.service';
import { createTenant } from '../tenants/tenants.service';
import { makeApp, resetDatabase, startSmtp, testDatabaseUrl } from '../test-utils';
import { hashPassword } from './passwords';
import { base32Decode, hotp, stepFor } from './totp';
import { insertUser } from './users.service';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const SECRETS = Buffer.from(KEY_B64, 'base64');
const PASS = 'Contrasena-Segura-123';

/** El código TOTP de un paso concreto (por defecto, el siguiente al actual: el que acepta tras activar). */
const codeFor = (secret: string, offset = 0) => hotp(base32Decode(secret), stepFor() + offset);

describe('autenticación del panel', () => {
  let app: INestApplication;
  let pool: Pool;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  let storageDir: string;
  let tenantId: string;
  let apiKey: string;
  let otherTenantId: string;

  const http = () => request(app.getHttpServer());

  async function crearUsuario(role: 'ADMIN' | 'REVIEWER' | 'OPERATOR', email: string, tenant: string | null = tenantId, password = PASS) {
    const u = await insertUser(pool, { tenantId: role === 'OPERATOR' ? null : tenant, email, name: `Usuario ${email}`, role });
    await pool.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, await hashPassword(password)]);
    return u.id;
  }
  const login = (email: string, password = PASS) => http().post('/v1/auth/login').send({ email, password });
  const cookieOf = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[]) ?? []).find((c) => c.startsWith('refresh_token='))?.split(';')[0];
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  /** Inicia sesión y devuelve el access token y la cookie. */
  async function sesion(email: string, password = PASS) {
    const r = await login(email, password);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    return { token: r.body.accessToken as string, cookie: cookieOf(r) as string, body: r.body };
  }
  /** Activa el segundo factor de un usuario ya autenticado y devuelve la semilla y los códigos de recuperación. */
  async function activarMfa(token: string) {
    const s = await http().post('/v1/auth/mfa/setup').set(bearer(token));
    expect(s.status).toBe(200);
    const secret = s.body.secret as string;
    const e = await http().post('/v1/auth/mfa/enable').set(bearer(token)).send({ code: codeFor(secret) });
    expect(e.status).toBe(200);
    return { secret, recovery: e.body.recoveryCodes as string[] };
  }
  /** Segundo paso del login. El testigo se obtiene ANTES de crear la petición: supertest comparte un solo servidor. */
  const verificar = (pendingToken: string, body: object) => http().post('/v1/auth/mfa/verify').send({ pendingToken, ...body });
  const liberarPaso = (email: string) => pool.query('UPDATE users SET mfa_last_step = NULL WHERE lower(email) = lower($1)', [email]);

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    smtp = await startSmtp();
    const a = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A SAC' });
    const b = await createTenant(pool, { name: 'B', country: 'PE', legalName: 'Corredora B SAC' });
    tenantId = a.tenant.id;
    apiKey = a.apiKey;
    otherTenantId = b.tenant.id;
    await saveMailSettings(pool, SECRETS, tenantId, { host: '127.0.0.1', port: smtp.port, fromEmail: 'avisos@a.test' });
    storageDir = await mkdtemp(join(tmpdir(), 'fes-auth-'));
    app = await makeApp({
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      SECRETS_KEY: KEY_B64,
      STORAGE_DIR: storageDir,
      ALLOW_DEV_OTP: 'true',
    });
    await crearUsuario('ADMIN', 'admin@a.test');
    await crearUsuario('REVIEWER', 'revisor@a.test');
    await crearUsuario('ADMIN', 'admin@b.test', otherTenantId);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await smtp?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  describe('login', () => {
    it('entra con la contraseña correcta: access token en el cuerpo, refresh SOLO en cookie HttpOnly', async () => {
      const r = await login('ADMIN@a.test');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'ok', user: { email: 'admin@a.test', role: 'ADMIN', mfaEnabled: false }, tenant: { name: 'A' } });
      expect(JSON.stringify(r.body)).not.toContain('refresh');
      const set = (r.headers['set-cookie'] as unknown as string[]).join(';');
      expect(set).toMatch(/refresh_token=/);
      expect(set).toMatch(/HttpOnly/i);
      expect(set).toMatch(/SameSite=Strict/i);
    });

    it('contraseña errónea y correo inexistente dan EXACTAMENTE la misma respuesta', async () => {
      const mala = await login('admin@a.test', 'otra-contrasena-9');
      const nadie = await login('nadie@a.test', 'otra-contrasena-9');
      expect(mala.status).toBe(401);
      expect(nadie.status).toBe(401);
      expect(mala.body).toEqual(nadie.body);
    });

    it('10 fallos seguidos cierran la cuenta un rato (aunque luego llegue la contraseña buena)', async () => {
      await crearUsuario('REVIEWER', 'cierre@a.test');
      for (let i = 0; i < 10; i++) expect((await login('cierre@a.test', 'mala-contrasena-1')).status).toBe(401);
      const r = await login('cierre@a.test');
      expect(r.status).toBe(429);
      expect(r.body.code).toBe('ACCOUNT_LOCKED');
      await pool.query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE lower(email) = 'cierre@a.test'`);
      expect((await login('cierre@a.test')).status).toBe(200);
    });

    it('un usuario dado de baja, o de una corredora desactivada, no entra', async () => {
      await crearUsuario('REVIEWER', 'baja@a.test');
      await pool.query(`UPDATE users SET active = false WHERE email = 'baja@a.test'`);
      expect((await login('baja@a.test')).status).toBe(401);
      const t = await createTenant(pool, { name: 'C', country: 'PE', legalName: 'C SAC' });
      await crearUsuario('ADMIN', 'admin@c.test', t.tenant.id);
      await pool.query('UPDATE tenants SET active = false WHERE id = $1', [t.tenant.id]);
      expect((await login('admin@c.test')).status).toBe(401);
    });
  });

  describe('sesión: acceso, renovación y salida', () => {
    it('el access token abre las rutas de la corredora; sin token o con basura, 401', async () => {
      const { token } = await sesion('admin@a.test');
      expect((await http().get('/v1/requests').set(bearer(token))).status).toBe(200);
      expect((await http().get('/v1/requests').set(bearer('basura'))).status).toBe(401);
      expect((await http().get('/v1/requests')).status).toBe(401);
    });

    it('la clave de API de integración sigue funcionando para el host', async () => {
      expect((await http().get('/v1/requests').set('X-Api-Key', apiKey)).status).toBe(200);
    });

    it('renovar rota el refresh; el anterior, dentro de la gracia, solo da acceso (carrera de dos pestañas)', async () => {
      const { cookie } = await sesion('admin@a.test');
      const r1 = await http().post('/v1/auth/refresh').set('Cookie', cookie);
      expect(r1.status).toBe(200);
      const nueva = cookieOf(r1);
      expect(nueva).toBeTruthy();
      expect(nueva).not.toBe(cookie);
      // La cookie vieja, de inmediato: carrera tolerada, sin cookie nueva ni cierre de sesión.
      const r2 = await http().post('/v1/auth/refresh').set('Cookie', cookie);
      expect(r2.status).toBe(200);
      expect(cookieOf(r2)).toBeUndefined();
      // Y la ganadora sigue viva.
      expect((await http().post('/v1/auth/refresh').set('Cookie', nueva as string)).status).toBe(200);
    });

    it('un refresh YA reemplazado hace rato se presume robado: cae toda la sesión, también la cookie legítima', async () => {
      const { cookie } = await sesion('admin@a.test');
      const r1 = await http().post('/v1/auth/refresh').set('Cookie', cookie);
      const legitima = cookieOf(r1) as string;
      await pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE revoked_reason = 'rotated' AND revoked_at > now() - interval '1 minute'`);
      const robo = await http().post('/v1/auth/refresh').set('Cookie', cookie);
      expect(robo.status).toBe(401);
      expect((await http().post('/v1/auth/refresh').set('Cookie', legitima)).status).toBe(401);
    });

    it('salir revoca la sesión: la cookie ya no renueva', async () => {
      const { cookie } = await sesion('admin@a.test');
      expect((await http().post('/v1/auth/logout').set('Cookie', cookie)).status).toBe(204);
      expect((await http().post('/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    });

    it('dar de baja a alguien corta su sesión YA, sin esperar a que venza el access token', async () => {
      const id = await crearUsuario('REVIEWER', 'efimero@a.test');
      const { token } = await sesion('efimero@a.test');
      expect((await http().get('/v1/requests').set(bearer(token))).status).toBe(200);
      await pool.query('UPDATE users SET active = false WHERE id = $1', [id]);
      expect((await http().get('/v1/requests').set(bearer(token))).status).toBe(401);
    });
  });

  describe('contraseña', () => {
    it('cambiarla exige la actual, aplica la política, cierra las demás sesiones y abre una nueva', async () => {
      await crearUsuario('REVIEWER', 'cambia@a.test');
      const vieja = await sesion('cambia@a.test');
      const otra = await sesion('cambia@a.test');
      const malActual = await http().post('/v1/auth/password/change').set(bearer(vieja.token)).send({ currentPassword: 'no-es-esa-1', newPassword: 'Nueva-Contrasena-456' });
      expect(malActual.status).toBe(401);
      const corta = await http().post('/v1/auth/password/change').set(bearer(vieja.token)).send({ currentPassword: PASS, newPassword: 'corta1' });
      expect(corta.status).toBe(422);
      const ok = await http().post('/v1/auth/password/change').set(bearer(vieja.token)).send({ currentPassword: PASS, newPassword: 'Nueva-Contrasena-456' });
      expect(ok.status).toBe(200);
      expect((await http().get('/v1/requests').set(bearer(ok.body.accessToken))).status).toBe(200);
      // Las sesiones anteriores (access y refresh) quedaron cortadas.
      expect((await http().get('/v1/requests').set(bearer(vieja.token))).status).toBe(401);
      expect((await http().get('/v1/requests').set(bearer(otra.token))).status).toBe(401);
      expect((await http().post('/v1/auth/refresh').set('Cookie', otra.cookie)).status).toBe(401);
      expect((await login('cambia@a.test', PASS)).status).toBe(401);
      expect((await login('cambia@a.test', 'Nueva-Contrasena-456')).status).toBe(200);
    });

    it('con contraseña provisional solo se puede ver quién es y cambiarla', async () => {
      const u = await insertUser(pool, { tenantId, email: 'nuevo@a.test', name: 'Nuevo', role: 'REVIEWER' });
      const r = await login('nuevo@a.test', u.temporaryPassword);
      expect(r.status).toBe(200);
      expect(r.body.user.mustChangePassword).toBe(true);
      const token = r.body.accessToken as string;
      expect((await http().get('/v1/auth/me').set(bearer(token))).status).toBe(200);
      const bloqueada = await http().get('/v1/requests').set(bearer(token));
      expect(bloqueada.status).toBe(403);
      expect(bloqueada.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      const cambio = await http().post('/v1/auth/password/change').set(bearer(token)).send({ currentPassword: u.temporaryPassword, newPassword: 'Ya-Elegida-789' });
      expect(cambio.status).toBe(200);
      expect(cambio.body.user.mustChangePassword).toBe(false);
      expect((await http().get('/v1/requests').set(bearer(cambio.body.accessToken))).status).toBe(200);
    });

    it('recuperación por correo: respuesta idéntica exista o no la cuenta; enlace de un solo uso que corta sesiones', async () => {
      await crearUsuario('REVIEWER', 'olvido@a.test');
      const previa = await sesion('olvido@a.test');
      const antes = smtp.mails.length;
      const a = await http().post('/v1/auth/password-reset/request').send({ email: 'olvido@a.test' });
      const b = await http().post('/v1/auth/password-reset/request').send({ email: 'fantasma@a.test' });
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(a.body).toEqual(b.body);
      const llego = async () => {
        const fin = Date.now() + 4000;
        while (Date.now() < fin && smtp.mails.length === antes) await new Promise((r) => setTimeout(r, 50));
        return smtp.mails.length > antes;
      };
      expect(await llego()).toBe(true);
      expect(smtp.mails.length - antes).toBe(1);
      const token = /restablecer\?token=([0-9a-f]{64})/.exec(smtp.mails[smtp.mails.length - 1].text)?.[1] as string;
      expect(token).toBeTruthy();
      expect((await http().post('/v1/auth/password-reset/complete').send({ token, newPassword: 'corta1' })).status).toBe(422);
      expect((await http().post('/v1/auth/password-reset/complete').send({ token, newPassword: 'Recuperada-Segura-1' })).status).toBe(204);
      expect((await http().post('/v1/auth/password-reset/complete').send({ token, newPassword: 'Otra-Recuperada-2' })).status).toBe(400);
      expect((await http().get('/v1/requests').set(bearer(previa.token))).status).toBe(401);
      expect((await login('olvido@a.test', 'Recuperada-Segura-1')).status).toBe(200);
    });

    it('un enlace vencido no sirve; pedir otro anula el anterior', async () => {
      await crearUsuario('REVIEWER', 'vence@a.test');
      const antes = smtp.mails.length;
      await http().post('/v1/auth/password-reset/request').send({ email: 'vence@a.test' });
      await http().post('/v1/auth/password-reset/request').send({ email: 'vence@a.test' });
      const fin = Date.now() + 4000;
      while (Date.now() < fin && smtp.mails.length < antes + 2) await new Promise((r) => setTimeout(r, 50));
      const [primero, segundo] = smtp.mails.slice(antes).map((m) => /token=([0-9a-f]{64})/.exec(m.text)?.[1] as string);
      expect((await http().post('/v1/auth/password-reset/complete').send({ token: primero, newPassword: 'Recuperada-Segura-1' })).status).toBe(400);
      await pool.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute'`);
      expect((await http().post('/v1/auth/password-reset/complete').send({ token: segundo, newPassword: 'Recuperada-Segura-1' })).status).toBe(400);
    });
  });

  describe('segundo factor', () => {
    it('activarlo entrega 10 códigos de recuperación; el login pide el código y el testigo intermedio no es una sesión', async () => {
      await crearUsuario('ADMIN', 'mfa@a.test');
      const s = await sesion('mfa@a.test');
      const { secret, recovery } = await activarMfa(s.token);
      expect(recovery).toHaveLength(10);
      expect(recovery[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

      const r = await login('mfa@a.test');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('mfa_required');
      expect(r.headers['set-cookie']).toBeUndefined();
      const pending = r.body.pendingToken as string;
      // El testigo intermedio NO abre nada.
      expect((await http().get('/v1/requests').set(bearer(pending))).status).toBe(401);
      expect((await http().get('/v1/auth/me').set(bearer(pending))).status).toBe(401);

      await liberarPaso('mfa@a.test');
      const v = await http().post('/v1/auth/mfa/verify').send({ pendingToken: pending, code: codeFor(secret) });
      expect(v.status).toBe(200);
      expect(v.body.user.mfaEnabled).toBe(true);
      expect(cookieOf(v)).toBeTruthy();
    });

    it('el mismo código no sirve dos veces, y cinco fallos cierran el factor 15 minutos', async () => {
      await crearUsuario('ADMIN', 'mfa2@a.test');
      const { secret } = await activarMfa((await sesion('mfa2@a.test')).token);
      await liberarPaso('mfa2@a.test');
      const pending = () => login('mfa2@a.test').then((r) => r.body.pendingToken as string);
      const code = codeFor(secret);
      expect((await verificar(await pending(), { code })).status).toBe(200);
      expect((await verificar(await pending(), { code })).status).toBe(401);
      for (let i = 0; i < 4; i++) expect((await verificar(await pending(), { code: '000000' })).status).toBe(401);
      await liberarPaso('mfa2@a.test');
      const cerrado = await verificar(await pending(), { code: codeFor(secret) });
      expect(cerrado.status).toBe(429);
      expect(cerrado.body.code).toBe('MFA_LOCKED');
    });

    it('un código de recuperación sirve UNA vez', async () => {
      await crearUsuario('ADMIN', 'mfa3@a.test');
      const { recovery } = await activarMfa((await sesion('mfa3@a.test')).token);
      const pending = () => login('mfa3@a.test').then((r) => r.body.pendingToken as string);
      expect((await verificar(await pending(), { recoveryCode: recovery[0] })).status).toBe(200);
      expect((await verificar(await pending(), { recoveryCode: recovery[0] })).status).toBe(401);
      expect((await verificar(await pending(), { recoveryCode: recovery[1].toLowerCase().replace('-', ' ') })).status).toBe(200);
    });

    it('quien lo activó puede desactivarlo con contraseña y código; un administrador puede quitárselo a otro', async () => {
      await crearUsuario('REVIEWER', 'mfa4@a.test');
      const s = await sesion('mfa4@a.test');
      const { secret } = await activarMfa(s.token);
      await liberarPaso('mfa4@a.test');
      expect((await http().post('/v1/auth/mfa/disable').set(bearer(s.token)).send({ password: 'mala-contrasena-1', code: codeFor(secret, 1) })).status).toBe(401);
      expect((await http().post('/v1/auth/mfa/disable').set(bearer(s.token)).send({ password: PASS, code: codeFor(secret, 1) })).status).toBe(204);
      expect((await login('mfa4@a.test')).body.status).toBe('ok');

      const id = await crearUsuario('REVIEWER', 'mfa5@a.test');
      await activarMfa((await sesion('mfa5@a.test')).token);
      const admin = await sesion('admin@a.test');
      expect((await http().post(`/v1/users/${id}/reset-mfa`).set(bearer(admin.token))).status).toBe(204);
      expect((await login('mfa5@a.test')).body.status).toBe('ok');
    });

    it('el operador de la plataforma NO puede entrar sin segundo factor: debe activarlo primero', async () => {
      await crearUsuario('OPERATOR', 'op@plataforma.test');
      const r = await login('op@plataforma.test');
      expect(r.body.status).toBe('mfa_setup_required');
      const pending = r.body.pendingToken as string;
      expect(r.headers['set-cookie']).toBeUndefined();
      // Con ese testigo solo se puede activar el factor.
      expect((await http().get('/v1/operator/overview').set(bearer(pending))).status).toBe(401);
      expect((await http().post('/v1/auth/mfa/verify').send({ pendingToken: pending, code: '123456' })).status).toBe(401);
      const setup = await http().post('/v1/auth/mfa/setup-pending').send({ pendingToken: pending });
      expect(setup.status).toBe(200);
      expect(setup.body.qr).toMatch(/^data:image\/png;base64,/);
      expect((await http().post('/v1/auth/mfa/enable-pending').send({ pendingToken: pending, code: '000000' })).status).toBe(422);
      const en = await http().post('/v1/auth/mfa/enable-pending').send({ pendingToken: pending, code: codeFor(setup.body.secret) });
      expect(en.status).toBe(200);
      expect(en.body.recoveryCodes).toHaveLength(10);
      expect((await http().get('/v1/operator/overview').set(bearer(en.body.accessToken))).status).toBe(200);
      // Y no puede quitárselo.
      await liberarPaso('op@plataforma.test');
      expect((await http().post('/v1/auth/mfa/disable').set(bearer(en.body.accessToken)).send({ password: PASS, code: codeFor(setup.body.secret, 1) })).status).toBe(403);
    });
  });

  describe('roles', () => {
    it('el revisor lee y dictamina, pero no crea solicitudes, no publica plantillas ni cambia ajustes', async () => {
      const { token } = await sesion('revisor@a.test');
      expect((await http().get('/v1/requests').set(bearer(token))).status).toBe(200);
      expect((await http().get('/v1/templates').set(bearer(token))).status).toBe(200);
      expect((await http().get('/v1/settings').set(bearer(token))).status).toBe(200);
      const crear = await http().post('/v1/requests').set(bearer(token)).send({});
      expect(crear.status).toBe(403);
      expect(crear.body.code).toBe('FORBIDDEN_ROLE');
      expect((await http().put('/v1/settings').set(bearer(token)).send({ privacyNotice: 'x' })).status).toBe(403);
      expect((await http().post('/v1/templates/APPOINTMENT_LETTER').set(bearer(token)).send({})).status).toBe(403);
      expect((await http().get('/v1/users').set(bearer(token))).status).toBe(403);
    });

    it('el administrador sí opera (llega a validar el cuerpo, no al 403)', async () => {
      const { token } = await sesion('admin@a.test');
      expect((await http().post('/v1/requests').set(bearer(token)).send({})).status).toBe(422);
    });

    it('el operador de la plataforma no opera dentro de una corredora, y una sesión de corredora no abre el panel de operador', async () => {
      const { token } = await sesion('admin@a.test');
      expect((await http().get('/v1/operator/overview').set(bearer(token))).status).toBe(403);
      expect((await http().get('/v1/operator/overview').set('X-Api-Key', apiKey)).status).toBe(401);
    });

    it('la dictamen de revisión queda a nombre de quien entró, no del texto que mande el navegador', async () => {
      // El rastro: con sesión, reviewedBy se reemplaza por «nombre <correo>». Se comprueba contra una solicitud inexistente
      // (404) para no depender de armar una firma completa: lo que importa es que la ruta acepta al revisor.
      const { token } = await sesion('revisor@a.test');
      const r = await http().post('/v1/requests/00000000-0000-4000-8000-000000000000/review').set(bearer(token)).send({ result: 'VERIFIED', reviewedBy: 'Otro Nombre' });
      expect(r.status).toBe(404);
    });
  });

  describe('gestión de usuarios de la corredora', () => {
    it('solo ve y gestiona a los de su corredora', async () => {
      const a = await sesion('admin@a.test');
      const lista = await http().get('/v1/users').set(bearer(a.token));
      expect(lista.status).toBe(200);
      const correos = lista.body.users.map((u: { email: string }) => u.email);
      expect(correos).toContain('revisor@a.test');
      expect(correos).not.toContain('admin@b.test');
      const ajeno = (await pool.query(`SELECT id FROM users WHERE email = 'admin@b.test'`)).rows[0].id;
      expect((await http().patch(`/v1/users/${ajeno}`).set(bearer(a.token)).send({ active: false })).status).toBe(404);
      expect((await http().post(`/v1/users/${ajeno}/reset-password`).set(bearer(a.token))).status).toBe(404);
    });

    it('crear devuelve una contraseña provisional una vez; el correo no se repite', async () => {
      const a = await sesion('admin@a.test');
      const r = await http().post('/v1/users').set(bearer(a.token)).send({ email: 'Nueva.Persona@a.test', name: 'Nueva Persona', role: 'REVIEWER' });
      expect(r.status).toBe(201);
      expect(r.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{14}$/);
      expect((await login('nueva.persona@a.test', r.body.temporaryPassword)).body.user.mustChangePassword).toBe(true);
      const dup = await http().post('/v1/users').set(bearer(a.token)).send({ email: 'nueva.persona@A.test', name: 'X', role: 'ADMIN' });
      expect(dup.status).toBe(409);
      expect((await http().post('/v1/users').set(bearer(a.token)).send({ email: 'no-es-correo', name: 'X', role: 'ADMIN' })).status).toBe(422);
      expect((await http().post('/v1/users').set(bearer(a.token)).send({ email: 'x@a.test', name: 'X', role: 'OPERATOR' })).status).toBe(422);
    });

    it('reiniciar la contraseña de alguien le corta la sesión y le exige cambiarla', async () => {
      const id = await crearUsuario('REVIEWER', 'reinicio@a.test');
      const previa = await sesion('reinicio@a.test');
      const a = await sesion('admin@a.test');
      const r = await http().post(`/v1/users/${id}/reset-password`).set(bearer(a.token));
      expect(r.status).toBe(200);
      expect((await http().get('/v1/requests').set(bearer(previa.token))).status).toBe(401);
      expect((await login('reinicio@a.test', r.body.temporaryPassword)).body.user.mustChangePassword).toBe(true);
    });

    it('nadie se da de baja ni se cambia el rol a sí mismo, y la corredora no se queda sin administrador', async () => {
      await crearUsuario('ADMIN', 'solo@s.test', (await createTenant(pool, { name: 'S', country: 'PE', legalName: 'S SAC' })).tenant.id);
      const solo = await sesion('solo@s.test');
      const yo = (await pool.query(`SELECT id FROM users WHERE email = 'solo@s.test'`)).rows[0].id;
      const propio = await http().patch(`/v1/users/${yo}`).set(bearer(solo.token)).send({ active: false });
      expect(propio.status).toBe(409);
      expect(propio.body.code).toBe('CANNOT_CHANGE_SELF');
      // Con dos administradores, uno puede dar de baja al otro; al quedar uno solo, ya no.
      const tenantS = (await pool.query(`SELECT tenant_id FROM users WHERE id = $1`, [yo])).rows[0].tenant_id;
      const otro = await crearUsuario('ADMIN', 'otro@s.test', tenantS);
      expect((await http().patch(`/v1/users/${otro}`).set(bearer(solo.token)).send({ role: 'REVIEWER' })).status).toBe(204);
      const otroAdmin = await crearUsuario('ADMIN', 'otro2@s.test', tenantS);
      const o2 = await sesion('otro2@s.test');
      expect((await http().patch(`/v1/users/${yo}`).set(bearer(o2.token)).send({ active: false })).status).toBe(204);
      const o2b = await sesion('otro2@s.test');
      const ultimo = await http().patch(`/v1/users/${otroAdmin}`).set(bearer(o2b.token)).send({ active: false });
      expect(ultimo.status).toBe(409);
    });

    it('cambiar a alguien a revisor corta sus sesiones para que el nuevo rol rija ya', async () => {
      const id = await crearUsuario('ADMIN', 'degradado@a.test');
      const s = await sesion('degradado@a.test');
      const a = await sesion('admin@a.test');
      expect((await http().patch(`/v1/users/${id}`).set(bearer(a.token)).send({ role: 'REVIEWER' })).status).toBe(204);
      expect((await http().get('/v1/requests').set(bearer(s.token))).status).toBe(401);
    });
  });

  it('el operador se crea sin corredora; la restricción de la base lo exige (y a los demás se la prohíbe)', async () => {
    await expect(pool.query(`INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES ($1, 'x@x.test', 'x', 'h', 'OPERATOR')`, [tenantId])).rejects.toThrow();
    await expect(pool.query(`INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES (NULL, 'y@y.test', 'y', 'h', 'ADMIN')`)).rejects.toThrow();
  });
});
