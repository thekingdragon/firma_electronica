/**
 * Pruebas de integración del envío del link POR EL SERVICIO (delivery.mode=SERVICE), con un servidor
 * SMTP real de captura. Requieren TEST_DATABASE_URL (base que termine en _test).
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { saveMailSettings } from '../mail/mail.service';
import { closedPort, makeApp, resetDatabase, SmtpCapture, startSmtp, testDatabaseUrl } from '../test-utils';
import { createTenant } from '../tenants/tenants.service';

const URL_DB = testDatabaseUrl();
const SECRETS_KEY = randomBytes(32);

const body = (extra: Record<string, unknown> = {}) => ({
  documentType: 'APPOINTMENT_LETTER',
  externalRef: 'cli-1',
  signer: { name: 'Ana Pérez Quispe', documentType: 'DNI', documentNumber: '12345678' },
  data: { insurances: ['SCTR Salud'] },
  otp: { channel: 'EMAIL', to: 'otp@example.com' },
  delivery: { mode: 'SERVICE', channel: 'EMAIL', to: 'ana@example.com' },
  ...extra,
});

describe('envío del link por el servicio', () => {
  let app: INestApplication;
  let pool: Pool;
  let smtp: SmtpCapture;
  const T: Record<string, { key: string; id: string }> = {};

  const post = (tenant: string, b: unknown, idem?: string) => {
    const r = request(app.getHttpServer()).post('/v1/requests').set('X-Api-Key', T[tenant].key);
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(b as object);
  };
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM signature_requests')).rows[0].n as number;
  const linkOf = (m: { text: string }) => /http\S+\/s\/([A-Za-z0-9_-]{43})/.exec(m.text)?.[1] as string;

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    smtp = await startSmtp();
    for (const name of ['Con correo', 'SMTP caido', 'Sin correo']) {
      const t = await createTenant(pool, { name, country: 'PE', legalName: `${name} Corredores SAC` });
      T[name] = { key: t.apiKey, id: t.tenant.id };
    }
    await saveMailSettings(pool, SECRETS_KEY, T['Con correo'].id, { host: '127.0.0.1', port: smtp.port, fromEmail: 'avisos@corredora.test', fromName: 'Corredora' });
    await saveMailSettings(pool, SECRETS_KEY, T['SMTP caido'].id, { host: '127.0.0.1', port: await closedPort(), fromEmail: 'x@corredora.test' });
    app = await makeApp({
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      SECRETS_KEY: SECRETS_KEY.toString('base64'),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await smtp?.close();
  });

  it('envía el link por correo desde el SMTP del tenant y no lo devuelve al host', async () => {
    const n = smtp.mails.length;
    const res = await post('Con correo', body());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.sentTo).toBe('a**@example.com');
    expect(res.body.signUrl).toBeUndefined();
    expect(smtp.mails.length).toBe(n + 1);

    const mail = smtp.mails[smtp.mails.length - 1];
    expect(mail.to).toBe('ana@example.com');
    expect(mail.from).toEqual({ address: 'avisos@corredora.test', name: 'Corredora' });
    expect(mail.text).toContain('Ana Pérez Quispe');
    expect(mail.text).toContain(res.body.reference);
    expect(mail.text).toContain('https://firma.test/s/');
    // El correo NO lleva el código OTP: ese sale aparte, al pedirlo el firmante.
    expect(mail.text).not.toMatch(/\b\d{6}\b/);
  });

  it('el link que llegó por correo abre la solicitud correcta', async () => {
    const res = await post('Con correo', body({ externalRef: 'abre-link' }));
    const mail = smtp.mails.find((m) => m.text.includes(res.body.reference));
    expect(mail).toBeDefined();
    if (!mail) return;
    const intro = await request(app.getHttpServer()).get(`/v1/sign/${linkOf(mail)}`);
    expect(intro.status).toBe(200);
    expect(intro.body.reference).toBe(res.body.reference);
  });

  it('avisa si el link y el código irían al mismo buzón (un solo factor real)', async () => {
    const igual = await post('Con correo', body({ externalRef: 'mismo', otp: { channel: 'EMAIL', to: 'Ana@Example.com' } }));
    expect(igual.status).toBe(201);
    expect(igual.body.warnings).toEqual(['LINK_AND_OTP_SAME_CHANNEL']);
    const distinto = await post('Con correo', body({ externalRef: 'distinto' }));
    expect(distinto.body.warnings).toBeUndefined();
  });

  it('validaciones: sin canal o destino, correo inválido, canal sin proveedor', async () => {
    const antes = await count();
    const a = await post('Con correo', body({ delivery: { mode: 'SERVICE' } }));
    expect(a.status).toBe(422);
    expect(a.body.code).toBe('INVALID_DELIVERY');
    const b = await post('Con correo', body({ delivery: { mode: 'SERVICE', channel: 'EMAIL', to: 'no-es-correo' } }));
    expect(b.body.code).toBe('INVALID_CONTACT');
    const c = await post('Con correo', body({ delivery: { mode: 'SERVICE', channel: 'WHATSAPP', to: '+51999999999' } }));
    expect(c.status).toBe(422);
    expect(c.body.code).toBe('CHANNEL_NOT_AVAILABLE');
    expect(await count()).toBe(antes);
  });

  it('tenant sin correo configurado: 409 y no se crea nada', async () => {
    const antes = await count();
    const res = await post('Sin correo', body());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MAIL_NOT_CONFIGURED');
    expect(await count()).toBe(antes);
  });

  it('si el SMTP falla, la solicitud NO queda creada (nada huérfano) y el motivo llega al host', async () => {
    const antes = await count();
    const res = await post('SMTP caido', body(), 'idem-fallo');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('MAIL_SEND_FAILED');
    expect(res.body.message).toContain('No se pudo conectar');
    expect(await count()).toBe(antes);

    // Reintentar con la misma Idempotency-Key no choca con nada: no quedó rastro.
    const otra = await post('SMTP caido', body(), 'idem-fallo');
    expect(otra.status).toBe(502);
    expect(await count()).toBe(antes);
  });

  it('repetir con la misma Idempotency-Key devuelve la misma solicitud y NO manda otro correo', async () => {
    const n = smtp.mails.length;
    const a = await post('Con correo', body({ externalRef: 'idem' }), 'idem-ok');
    const b = await post('Con correo', body({ externalRef: 'idem' }), 'idem-ok');
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(smtp.mails.length).toBe(n + 1);
  });

  it('dos peticiones simultáneas con la misma clave: una sola solicitud y UN solo correo', async () => {
    const n = smtp.mails.length;
    const [a, b] = await Promise.all([
      post('Con correo', body({ externalRef: 'carrera' }), 'idem-carrera'),
      post('Con correo', body({ externalRef: 'carrera' }), 'idem-carrera'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(smtp.mails.length).toBe(n + 1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM signature_requests WHERE idempotency_key='idem-carrera'`)).rows[0].n).toBe(1);
  });

  it('el modo HOST sigue igual: devuelve el link y no envía nada', async () => {
    const n = smtp.mails.length;
    const res = await post('Con correo', body({ delivery: { mode: 'HOST' }, externalRef: 'host' }));
    expect(res.status).toBe(201);
    expect(res.body.signUrl).toMatch(/^https:\/\/firma\.test\/s\//);
    expect(res.body.sentTo).toBeUndefined();
    expect(smtp.mails.length).toBe(n);
  });
});
