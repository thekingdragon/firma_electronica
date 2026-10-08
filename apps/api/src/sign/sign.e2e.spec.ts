/**
 * Pruebas de integración del flujo público de firma: intro, OTP por SMTP real, verificación y
 * sesión. Requieren TEST_DATABASE_URL (base que termine en _test).
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { saveMailSettings } from '../mail/mail.service';
import { closedPort, makeApp, resetDatabase, SmtpCapture, startSmtp, testDatabaseUrl } from '../test-utils';
import { createTenant } from '../tenants/tenants.service';

const URL = testDatabaseUrl();
const SECRETS_KEY = randomBytes(32);
const BASE_ENV = {
  DATABASE_URL: URL,
  TOKEN_SECRET: 't'.repeat(40),
  PUBLIC_BASE_URL: 'https://firma.test',
  NODE_ENV: 'test',
  SECRETS_KEY: SECRETS_KEY.toString('base64'),
};

const body = (email = 'ana@example.com') => ({
  documentType: 'APPOINTMENT_LETTER',
  externalRef: 'cli-1',
  signer: { name: 'Ana Pérez Quispe', documentType: 'DNI', documentNumber: '12345678' },
  data: { insurances: ['SCTR Salud', 'SCTR Pensión'] },
  otp: { channel: 'EMAIL', to: email },
  delivery: { mode: 'HOST' },
});

describe('flujo público de firma', () => {
  let app: INestApplication;
  let devApp: INestApplication;
  let pool: Pool;
  let smtp: SmtpCapture;
  let smtpAuth: SmtpCapture;

  // Un tenant por escenario de correo.
  const tenants: Record<string, { key: string; id: string }> = {};

  async function mkTenant(name: string) {
    const t = await createTenant(pool, { name, country: 'PE', legalName: `${name} Corredores SAC` });
    tenants[name] = { key: t.apiKey, id: t.tenant.id };
    return t.tenant.id;
  }

  /** Crea una solicitud por la API y devuelve su id y el token del link. */
  async function mkRequest(tenant: string, email = 'ana@example.com', theApp = app) {
    const res = await request(theApp.getHttpServer())
      .post('/v1/requests')
      .set('X-Api-Key', tenants[tenant].key)
      .send(body(email));
    expect(res.status).toBe(201);
    return { id: res.body.id as string, token: (res.body.signUrl as string).split('/s/')[1] };
  }

  const http = (theApp = app) => request(theApp.getHttpServer());
  const codeFrom = (mails: SmtpCapture['mails']) => /\b(\d{6})\b/.exec(mails[mails.length - 1].text ?? '')?.[1] as string;
  /** Salta el enfriamiento y el vencimiento: mueve al pasado lo ya enviado de esa solicitud. */
  const backdate = (id: string, secs: number) =>
    pool.query(`UPDATE otp_challenges SET sent_at = sent_at - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2) WHERE request_id = $1`, [id, secs]);

  beforeAll(async () => {
    pool = await resetDatabase(URL);
    smtp = await startSmtp();
    smtpAuth = await startSmtp({ user: 'robot', pass: 'clave-super-secreta' });

    const withMail = await mkTenant('Con correo');
    await saveMailSettings(pool, SECRETS_KEY, withMail, {
      host: '127.0.0.1', port: smtp.port, fromEmail: 'no-responder@corredora.test', fromName: 'Corredora, S.A.C.',
    });

    const authId = await mkTenant('Con autenticacion');
    await saveMailSettings(pool, SECRETS_KEY, authId, {
      host: '127.0.0.1', port: smtpAuth.port, username: 'robot', password: 'clave-super-secreta', fromEmail: 'auth@corredora.test',
    });

    const badAuthId = await mkTenant('Clave mala');
    await saveMailSettings(pool, SECRETS_KEY, badAuthId, {
      host: '127.0.0.1', port: smtpAuth.port, username: 'robot', password: 'otra-clave', fromEmail: 'auth@corredora.test',
    });

    const downId = await mkTenant('SMTP caido');
    await saveMailSettings(pool, SECRETS_KEY, downId, {
      host: '127.0.0.1', port: await closedPort(), fromEmail: 'x@corredora.test',
    });

    await mkTenant('Sin correo');
    const noOtpId = await mkTenant('Sin otp');
    await pool.query(`UPDATE document_templates SET otp_required = false WHERE tenant_id = $1`, [noOtpId]);

    app = await makeApp({ ...BASE_ENV, ALLOW_DEV_OTP: 'false' });
    devApp = await makeApp({ ...BASE_ENV, ALLOW_DEV_OTP: 'true' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await devApp?.close();
    await pool?.end();
    await smtp?.close();
    await smtpAuth?.close();
  });

  describe('intro (antes del OTP)', () => {
    it('muestra lo mínimo y nada del contenido ni de los datos del firmante', async () => {
      const { token } = await mkRequest('Con correo');
      const res = await http().get(`/v1/sign/${token}`);
      expect(res.status).toBe(200);
      expect(res.body.issuer.name).toBe('Con correo Corredores SAC');
      expect(res.body.otpRequired).toBe(true);
      expect(res.body.otpTo).toBe('a**@example.com');
      const dump = JSON.stringify(res.body);
      expect(dump).not.toContain('Ana');
      expect(dump).not.toContain('12345678');
      expect(dump).not.toContain('SCTR');
      expect(dump).not.toContain('ana@example.com');
    });

    it('un token mal formado o inexistente da 404 igual', async () => {
      const a = await http().get('/v1/sign/corto');
      const b = await http().get(`/v1/sign/${'A'.repeat(43)}`);
      expect(a.status).toBe(404);
      expect(b.status).toBe(404);
      expect(a.body.code).toBe('LINK_NOT_FOUND');
      expect(b.body).toEqual(a.body);
    });

    it.each([
      ['SIGNED', 'ALREADY_SIGNED'],
      ['REVOKED', 'LINK_REVOKED'],
      ['REJECTED', 'LINK_REVOKED'],
      ['EXPIRED', 'LINK_EXPIRED'],
    ])('una solicitud %s da 410 %s', async (status, code) => {
      const { id, token } = await mkRequest('Con correo');
      if (status === 'SIGNED') {
        await pool.query(`UPDATE signature_requests SET status='SIGNED', signed_at=now(), pdf_path='x', pdf_sha256=repeat('a',64) WHERE id=$1`, [id]);
      } else {
        await pool.query(`UPDATE signature_requests SET status=$2 WHERE id=$1`, [id, status]);
      }
      const res = await http().get(`/v1/sign/${token}`);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe(code);
    });

    it('una solicitud pendiente pero vencida por fecha da 410 LINK_EXPIRED', async () => {
      const { id, token } = await mkRequest('Con correo');
      await pool.query(`UPDATE signature_requests SET expires_at = now() - interval '1 minute' WHERE id=$1`, [id]);
      const res = await http().get(`/v1/sign/${token}`);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('LINK_EXPIRED');
    });

    it('registra la apertura con la IP', async () => {
      const { id, token } = await mkRequest('Con correo');
      await http().get(`/v1/sign/${token}`).set('User-Agent', 'PruebaNavegador/1.0');
      const { rows } = await pool.query(`SELECT ip::text, user_agent FROM access_log WHERE request_id=$1 AND event='link_opened'`, [id]);
      expect(rows[0].ip).toMatch(/^127\.0\.0\.1/);
      expect(rows[0].user_agent).toBe('PruebaNavegador/1.0');
    });
  });

  describe('pedir el OTP', () => {
    it('envía un correo real por SMTP con un código de 6 dígitos', async () => {
      const { id, token } = await mkRequest('Con correo');
      const antes = smtp.mails.length;
      const res = await http().post(`/v1/sign/${token}/otp`);
      expect(res.status).toBe(200);
      expect(res.body.sentTo).toBe('a**@example.com');
      expect(res.body.devCode).toBeUndefined();
      expect(smtp.mails.length).toBe(antes + 1);

      const mail = smtp.mails[smtp.mails.length - 1];
      expect(mail.to).toBe('ana@example.com');
      expect(mail.from).toEqual({ address: 'no-responder@corredora.test', name: 'Corredora, S.A.C.' });
      expect(mail.text).toMatch(/\b\d{6}\b/);
      expect(mail.text).toContain('Con correo Corredores SAC');

      const { rows } = await pool.query(`SELECT code_hash, sent_at, attempts FROM otp_challenges WHERE request_id=$1`, [id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].sent_at).not.toBeNull();
      expect(rows[0].code_hash).not.toContain(codeFrom(smtp.mails));
    });

    it('el enfriamiento impide un segundo envío inmediato y no manda otro correo', async () => {
      const { token } = await mkRequest('Con correo');
      await http().post(`/v1/sign/${token}/otp`).expect(200);
      const n = smtp.mails.length;
      const res = await http().post(`/v1/sign/${token}/otp`);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('OTP_COOLDOWN');
      expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(smtp.mails.length).toBe(n);
    });

    it('dos pedidos simultáneos mandan UN solo correo', async () => {
      const { token } = await mkRequest('Con correo');
      const n = smtp.mails.length;
      const [a, b] = await Promise.all([http().post(`/v1/sign/${token}/otp`), http().post(`/v1/sign/${token}/otp`)]);
      expect([a.status, b.status].sort()).toEqual([200, 429]);
      expect(smtp.mails.length).toBe(n + 1);
    });

    it('pasado el enfriamiento se puede pedir otro, y el anterior deja de valer', async () => {
      const { id, token } = await mkRequest('Con correo');
      await http().post(`/v1/sign/${token}/otp`).expect(200);
      const viejo = codeFrom(smtp.mails);
      await backdate(id, 61);
      await http().post(`/v1/sign/${token}/otp`).expect(200);
      const nuevo = codeFrom(smtp.mails);
      expect(nuevo).not.toBe(viejo);

      // Solo el último desafío queda vivo; el anterior queda marcado como reemplazado.
      const estado = await pool.query(
        `SELECT superseded_at IS NOT NULL AS reemplazado FROM otp_challenges WHERE request_id = $1 ORDER BY sent_at`,
        [id],
      );
      expect(estado.rows.map((r) => r.reemplazado)).toEqual([true, false]);

      const conViejo = await http().post(`/v1/sign/${token}/verify`).send({ code: viejo });
      expect(conViejo.status).toBe(401);
      const conNuevo = await http().post(`/v1/sign/${token}/verify`).send({ code: nuevo });
      expect(conNuevo.status).toBe(200);
    });

    it('tope de 5 envíos por hora', async () => {
      const { id, token } = await mkRequest('Con correo');
      for (let i = 0; i < 5; i++) {
        await http().post(`/v1/sign/${token}/otp`).expect(200);
        await backdate(id, 120); // fuera del enfriamiento, dentro de la hora
      }
      const res = await http().post(`/v1/sign/${token}/otp`);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('OTP_RATE_LIMITED');
    });

    it('sin correo configurado: 409 claro y no queda ningún desafío', async () => {
      const { id, token } = await mkRequest('Sin correo');
      const res = await http().post(`/v1/sign/${token}/otp`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MAIL_NOT_CONFIGURED');
      const { rowCount } = await pool.query('SELECT 1 FROM otp_challenges WHERE request_id=$1', [id]);
      expect(rowCount).toBe(0);
    });

    it('SMTP caído: 502 sin filtrar detalles, nada persistido, y se puede reintentar de inmediato', async () => {
      const { id, token } = await mkRequest('SMTP caido');
      const res = await http().post(`/v1/sign/${token}/otp`);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('MAIL_SEND_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
      expect((await pool.query('SELECT 1 FROM otp_challenges WHERE request_id=$1', [id])).rowCount).toBe(0);

      const again = await http().post(`/v1/sign/${token}/otp`);
      expect(again.status).toBe(502); // sigue caído, pero NO es 429: el intento fallido no cuenta como envío

      const { rows } = await pool.query('SELECT last_error FROM tenant_mail_settings WHERE tenant_id=$1', [tenants['SMTP caido'].id]);
      expect(rows[0].last_error).toMatch(/No se pudo conectar/);
    });

    it('con SMTP autenticado descifra la contraseña guardada y envía', async () => {
      const { token } = await mkRequest('Con autenticacion');
      const n = smtpAuth.mails.length;
      await http().post(`/v1/sign/${token}/otp`).expect(200);
      expect(smtpAuth.mails.length).toBe(n + 1);
    });

    it('con la contraseña SMTP equivocada: 502 y el error explicado queda para el corredor', async () => {
      const { token } = await mkRequest('Clave mala');
      const res = await http().post(`/v1/sign/${token}/otp`);
      expect(res.status).toBe(502);
      const { rows } = await pool.query('SELECT last_error FROM tenant_mail_settings WHERE tenant_id=$1', [tenants['Clave mala'].id]);
      expect(rows[0].last_error).toMatch(/usuario o la contraseña/);
    });

    it('la contraseña SMTP no está en claro en la base', async () => {
      const { rows } = await pool.query('SELECT password_enc FROM tenant_mail_settings WHERE tenant_id=$1', [tenants['Con autenticacion'].id]);
      expect(rows[0].password_enc).toMatch(/^v1:/);
      expect(rows[0].password_enc).not.toContain('clave-super-secreta');
    });

    it('un documento sin OTP por política responde 409 al pedirlo', async () => {
      const res = await http()
        .post('/v1/requests')
        .set('X-Api-Key', tenants['Sin otp'].key)
        .send({ ...body(), otp: undefined });
      expect(res.status).toBe(201);
      const token = (res.body.signUrl as string).split('/s/')[1];
      const r = await http().post(`/v1/sign/${token}/otp`);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('OTP_NOT_REQUIRED');
    });
  });

  describe('verificar el OTP', () => {
    async function pedir(tenant = 'Con correo') {
      const r = await mkRequest(tenant);
      await http().post(`/v1/sign/${r.token}/otp`).expect(200);
      return { ...r, code: codeFrom(smtp.mails) };
    }
    const mal = (code: string) => (code === '000000' ? '111111' : '000000');

    it('con el código correcto entrega la sesión y el documento completo', async () => {
      const { id, token, code } = await pedir();
      const res = await http().post(`/v1/sign/${token}/verify`).send({ code });
      expect(res.status).toBe(200);
      expect(res.body.sessionToken).toMatch(/^[\w-]+\.[\w-]+$/);
      const v = res.body.view;
      expect(v.signer).toEqual({ name: 'Ana Pérez Quispe', documentType: 'DNI', documentNumber: '12345678' });
      expect(v.data.insurances).toEqual(['SCTR Salud', 'SCTR Pensión']);
      // El servidor entrega el documento como bloques ya completos (variables resueltas, listas de datos
      // resueltas): la página solo los dibuja y no duplica ningún texto de la carta.
      const bloques = v.blocks as Array<{ type: string; [k: string]: unknown }>;
      expect(v.content).toBeUndefined();
      expect(v.annexText).toBeUndefined();
      expect(bloques.find((b) => b.type === 'title')?.text).toBe('CARTA DE NOMBRAMIENTO');
      const facultades = bloques.find((b) => b.type === 'powers') as unknown as { items: unknown[]; intro: string };
      expect(facultades.items).toHaveLength(6);
      expect(facultades.intro).toContain('facultados');
      expect(bloques.find((b) => b.type === 'destinatario' || (b.type === 'paragraph' && String(b.text).includes('Señores')))?.text).toContain('Con correo Corredores SAC');
      const seguros = bloques.find((b) => b.type === 'list' && b.style === 'letters') as unknown as { items: string[] };
      expect(seguros.items).toEqual(['**SCTR Salud**', '**SCTR Pensión**']);
      const anexo = bloques.find((b) => b.type === 'annex') as unknown as { text: string };
      expect(anexo.text).toContain('Obligaciones del corredor de seguros');
      expect(v.clause.text).toContain('BORRADOR');
      expect(v.clause.version).toBe(1);
      expect(v.policy).toEqual({ photoRequired: true, photoChallengeRequired: true, idPhotoRequired: true, idPhotoBackRequired: true });
      expect(v.issuer.legalName).toBe('Con correo Corredores SAC');

      const ev = await pool.query(`SELECT event FROM access_log WHERE request_id=$1 ORDER BY id`, [id]);
      expect(ev.rows.map((r) => r.event)).toEqual(['otp_sent', 'otp_verified', 'session_opened']);
      expect((await pool.query('SELECT consumed_at FROM otp_challenges WHERE request_id=$1', [id])).rows[0].consumed_at).not.toBeNull();
    });

    it('un código ya usado no sirve otra vez', async () => {
      const { token, code } = await pedir();
      await http().post(`/v1/sign/${token}/verify`).send({ code }).expect(200);
      const again = await http().post(`/v1/sign/${token}/verify`).send({ code });
      expect(again.status).toBe(401);
      expect(again.body.code).toBe('OTP_NOT_REQUESTED');
    });

    it('un código incorrecto da 401 y descuenta intentos', async () => {
      const { token, code } = await pedir();
      const a = await http().post(`/v1/sign/${token}/verify`).send({ code: mal(code) });
      const b = await http().post(`/v1/sign/${token}/verify`).send({ code: mal(code) });
      expect(a.status).toBe(401);
      expect(a.body.code).toBe('OTP_INVALID');
      expect(a.body.attemptsLeft).toBe(4);
      expect(b.body.attemptsLeft).toBe(3);
    });

    it('tras 5 fallos se bloquea, incluso con el código correcto', async () => {
      const { token, code } = await pedir();
      for (let i = 0; i < 5; i++) await http().post(`/v1/sign/${token}/verify`).send({ code: mal(code) }).expect(401);
      const blocked = await http().post(`/v1/sign/${token}/verify`).send({ code });
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('OTP_LOCKED');
    });

    it('un código nuevo desbloquea tras el bloqueo', async () => {
      const { id, token, code } = await pedir();
      for (let i = 0; i < 5; i++) await http().post(`/v1/sign/${token}/verify`).send({ code: mal(code) });
      await backdate(id, 61);
      await http().post(`/v1/sign/${token}/otp`).expect(200);
      await http().post(`/v1/sign/${token}/verify`).send({ code: codeFrom(smtp.mails) }).expect(200);
    });

    it('20 intentos simultáneos solo llegan a comparar 5 (no se puede forzar en paralelo)', async () => {
      const { id, token, code } = await pedir();
      const res = await Promise.all(Array.from({ length: 20 }, () => http().post(`/v1/sign/${token}/verify`).send({ code: mal(code) })));
      expect(res.filter((r) => r.status === 401)).toHaveLength(5);
      expect(res.filter((r) => r.status === 429)).toHaveLength(15);
      expect((await pool.query('SELECT attempts FROM otp_challenges WHERE request_id=$1', [id])).rows[0].attempts).toBe(5);
    });

    it('un código con formato inválido da 422 y no gasta un intento', async () => {
      const { id, token } = await pedir();
      for (const bad of ['abc', '12345', '1234567', '']) {
        expect((await http().post(`/v1/sign/${token}/verify`).send({ code: bad })).status).toBe(422);
      }
      expect((await http().post(`/v1/sign/${token}/verify`).send({})).status).toBe(422);
      expect((await pool.query('SELECT attempts FROM otp_challenges WHERE request_id=$1', [id])).rows[0].attempts).toBe(0);
    });

    it('sin haber pedido código: 401 OTP_NOT_REQUESTED', async () => {
      const { token } = await mkRequest('Con correo');
      const res = await http().post(`/v1/sign/${token}/verify`).send({ code: '123456' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('OTP_NOT_REQUESTED');
    });

    it('un código vencido da 401 OTP_EXPIRED aunque sea el correcto', async () => {
      const { id, token, code } = await pedir();
      await pool.query(`UPDATE otp_challenges SET expires_at = now() - interval '1 second' WHERE request_id=$1`, [id]);
      const res = await http().post(`/v1/sign/${token}/verify`).send({ code });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('OTP_EXPIRED');
    });

    it('el código de una solicitud no sirve en otra', async () => {
      const a = await pedir();
      const b = await pedir();
      const res = await http().post(`/v1/sign/${b.token}/verify`).send({ code: a.code === b.code ? mal(a.code) : a.code });
      expect(res.status).toBe(401);
    });

    it('sin OTP por política: se abre la sesión sin código', async () => {
      const created = await http().post('/v1/requests').set('X-Api-Key', tenants['Sin otp'].key).send({ ...body(), otp: undefined });
      const token = (created.body.signUrl as string).split('/s/')[1];
      const intro = await http().get(`/v1/sign/${token}`);
      expect(intro.body.otpRequired).toBe(false);
      expect(intro.body.otpTo).toBeNull();
      const res = await http().post(`/v1/sign/${token}/verify`).send({});
      expect(res.status).toBe(200);
      expect(res.body.sessionToken).toBeDefined();
    });
  });

  describe('sesión y documento', () => {
    async function conSesion() {
      const r = await mkRequest('Con correo');
      await http().post(`/v1/sign/${r.token}/otp`).expect(200);
      const v = await http().post(`/v1/sign/${r.token}/verify`).send({ code: codeFrom(smtp.mails) }).expect(200);
      return { ...r, session: v.body.sessionToken as string };
    }

    it('con la sesión se puede volver a abrir el documento (recarga de página)', async () => {
      const { token, session } = await conSesion();
      const res = await http().get(`/v1/sign/${token}/view`).set('X-Session', session);
      expect(res.status).toBe(200);
      expect(res.body.signer.name).toBe('Ana Pérez Quispe');
    });

    it('sin sesión, con sesión alterada o de otra solicitud: 401', async () => {
      const a = await conSesion();
      const b = await conSesion();
      expect((await http().get(`/v1/sign/${a.token}/view`)).status).toBe(401);
      expect((await http().get(`/v1/sign/${a.token}/view`).set('X-Session', a.session.slice(0, -2) + 'xx')).status).toBe(401);
      expect((await http().get(`/v1/sign/${a.token}/view`).set('X-Session', b.session)).status).toBe(401);
    });

    it('revocar la solicitud corta la sesión aunque no haya vencido', async () => {
      const { id, token, session } = await conSesion();
      await pool.query(`UPDATE signature_requests SET status='REVOKED' WHERE id=$1`, [id]);
      const res = await http().get(`/v1/sign/${token}/view`).set('X-Session', session);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('LINK_REVOKED');
    });
  });

  describe('modo desarrollo (ALLOW_DEV_OTP)', () => {
    it('sin correo configurado devuelve el código en la respuesta y no envía nada', async () => {
      const { token } = await mkRequest('Sin correo', 'dev@example.com', devApp);
      const res = await http(devApp).post(`/v1/sign/${token}/otp`);
      expect(res.status).toBe(200);
      expect(res.body.devCode).toMatch(/^\d{6}$/);
      const ok = await http(devApp).post(`/v1/sign/${token}/verify`).send({ code: res.body.devCode });
      expect(ok.status).toBe(200);
    });

    it('con correo configurado NO devuelve el código: envía el correo', async () => {
      const { token } = await mkRequest('Con correo', 'dev@example.com', devApp);
      const n = smtp.mails.length;
      const res = await http(devApp).post(`/v1/sign/${token}/otp`);
      expect(res.status).toBe(200);
      expect(res.body.devCode).toBeUndefined();
      expect(smtp.mails.length).toBe(n + 1);
    });

    it('la instancia normal sigue rechazando el tenant sin correo', async () => {
      const { token } = await mkRequest('Sin correo');
      expect((await http().post(`/v1/sign/${token}/otp`)).status).toBe(409);
    });
  });
});
