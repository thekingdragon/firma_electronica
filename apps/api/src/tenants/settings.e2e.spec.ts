/**
 * Ajustes de la corredora (aviso de datos personales) y su efecto en los correos del servicio.
 * Requiere TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { saveMailSettings } from '../mail/mail.service';
import { CapturedMail, makeApp, resetDatabase, startSmtp, testDatabaseUrl } from '../test-utils';
import { createTenant } from './tenants.service';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const SECRETS_KEY = Buffer.from(KEY_B64, 'base64');
const AVISO = 'Importante sobre el uso de sus datos personales:\nSus datos se tratan conforme a la Ley N.º 29733.\n<b>No es HTML</b> & más.';

describe('ajustes: aviso de datos personales', () => {
  let app: INestApplication;
  let pool: Pool;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  let storageDir: string;
  let keyA: string;
  let keyB: string;

  const http = () => request(app.getHttpServer());
  const as = (key: string) => ({ 'X-Api-Key': key });

  async function enviarCodigo(key: string): Promise<CapturedMail> {
    const antes = smtp.mails.length;
    const c = await http()
      .post('/v1/requests')
      .set(as(key))
      .send({
        documentType: 'APPOINTMENT_LETTER',
        externalRef: `r-${randomBytes(4).toString('hex')}`,
        signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
        data: { insurances: ['SCTR'] },
        otp: { channel: 'EMAIL', to: 'ana@example.com' },
        delivery: { mode: 'HOST' },
      });
    expect(c.status).toBe(201);
    const token = (c.body.signUrl as string).split('/s/')[1];
    expect((await http().post(`/v1/sign/${token}/otp`)).status).toBe(200);
    expect(smtp.mails.length).toBe(antes + 1);
    return smtp.mails[smtp.mails.length - 1];
  }

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    smtp = await startSmtp();
    const a = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A SAC' });
    const b = await createTenant(pool, { name: 'B', country: 'PE', legalName: 'Corredora B SAC' });
    keyA = a.apiKey;
    keyB = b.apiKey;
    await saveMailSettings(pool, SECRETS_KEY, a.tenant.id, { host: '127.0.0.1', port: smtp.port, fromEmail: 'avisos@a.test' });
    await saveMailSettings(pool, SECRETS_KEY, b.tenant.id, { host: '127.0.0.1', port: smtp.port, fromEmail: 'avisos@b.test' });
    storageDir = await mkdtemp(join(tmpdir(), 'fes-settings-'));
    app = await makeApp({
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      SECRETS_KEY: KEY_B64,
      STORAGE_DIR: storageDir,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await smtp?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('sin clave de API: 401', async () => {
    expect((await http().get('/v1/settings')).status).toBe(401);
    expect((await http().put('/v1/settings').send({ privacyNotice: 'x' })).status).toBe(401);
  });

  it('al empezar no hay aviso, y los correos salen sin él', async () => {
    const r = await http().get('/v1/settings').set(as(keyA));
    expect(r.body).toEqual({ privacyNotice: null });
    const mail = await enviarCodigo(keyA);
    expect(mail.text).toContain('Su código de verificación es');
    expect(mail.text).not.toContain('Ley N.º 29733');
  });

  it('se guarda y el código de verificación sale con el aviso al pie', async () => {
    const put = await http().put('/v1/settings').set(as(keyA)).send({ privacyNotice: `  ${AVISO}  ` });
    expect(put.status).toBe(200);
    expect(put.body.privacyNotice).toBe(AVISO); // sin los espacios de los bordes
    expect((await http().get('/v1/settings').set(as(keyA))).body.privacyNotice).toBe(AVISO);

    const mail = await enviarCodigo(keyA);
    expect(mail.text).toContain('Su código de verificación es');
    expect(mail.text).toContain('Importante sobre el uso de sus datos personales:');
    expect(mail.text).toContain('Ley N.º 29733');
    // El aviso va DESPUÉS del contenido, no en lugar de él.
    expect(mail.text.indexOf('Su código de verificación')).toBeLessThan(mail.text.indexOf('Importante sobre'));
  });

  it('en la parte HTML el aviso se escapa: texto plano, nunca HTML', async () => {
    // Solo la parte HTML (la de texto plano lleva el aviso tal cual, y está bien). Se quitan los cortes de línea
    // y el `=3D` de quoted-printable para comparar el contenido.
    const html = smtp.mails[smtp.mails.length - 1].raw.split(/Content-Type: text\/html/i)[1].replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    expect(html).toContain('&lt;b&gt;No es HTML&lt;/b&gt; &amp; m');
    expect(html).not.toContain('<b>No es HTML</b>');
    expect(html).toContain('<br>'); // los saltos de línea del aviso se conservan
  });

  it('el aviso de una corredora no sale en los correos de otra', async () => {
    const mail = await enviarCodigo(keyB);
    expect(mail.text).not.toContain('Ley N.º 29733');
    expect((await http().get('/v1/settings').set(as(keyB))).body).toEqual({ privacyNotice: null });
  });

  it('vacío o solo espacios lo quita; null también', async () => {
    expect((await http().put('/v1/settings').set(as(keyA)).send({ privacyNotice: '   ' })).body).toEqual({ privacyNotice: null });
    await http().put('/v1/settings').set(as(keyA)).send({ privacyNotice: AVISO });
    expect((await http().put('/v1/settings').set(as(keyA)).send({ privacyNotice: null })).body).toEqual({ privacyNotice: null });
    expect((await enviarCodigo(keyA)).text).not.toContain('Ley N.º 29733');
  });

  it('valida: más de 5000 caracteres, campos de más, tipos incorrectos', async () => {
    const put = (b: unknown) => http().put('/v1/settings').set(as(keyA)).send(b as object);
    expect((await put({ privacyNotice: 'x'.repeat(5001) })).status).toBe(422);
    expect((await put({ privacyNotice: 'ok', otro: 1 })).status).toBe(422);
    expect((await put({ privacyNotice: 5 })).status).toBe(422);
    expect((await put({})).status).toBe(422);
    expect((await put({ privacyNotice: 'x'.repeat(5000) })).status).toBe(200);
  });
});
