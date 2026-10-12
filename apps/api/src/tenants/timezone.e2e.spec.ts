/**
 * Zona horaria por corredora: se configura, se valida, y las horas que salen (correo, ajustes, /me) usan SU zona con el
 * desfase al lado. Requiere TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { saveMailSettings } from '../mail/mail.service';
import { makeApp, resetDatabase, startSmtp, testDatabaseUrl } from '../test-utils';
import { createTenant } from './tenants.service';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');

describe('zona horaria de la corredora', () => {
  let app: INestApplication;
  let pool: Pool;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  let storageDir: string;
  let keyLima: string;
  let keyTokio: string;

  const http = () => request(app.getHttpServer());

  const solicitud = (to: string) => ({
    documentType: 'APPOINTMENT_LETTER',
    externalRef: `r-${randomBytes(4).toString('hex')}`,
    signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
    data: { insurances: ['SCTR'] },
    otp: { channel: 'EMAIL', to },
    delivery: { mode: 'SERVICE', channel: 'EMAIL', to },
  });

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    smtp = await startSmtp();
    const lima = await createTenant(pool, { name: 'Lima', country: 'PE', legalName: 'Corredora Lima SAC' });
    const tokio = await createTenant(pool, { name: 'Tokio', country: 'JP', legalName: 'Corredora Tokio KK', timezone: 'Asia/Tokyo' });
    keyLima = lima.apiKey;
    keyTokio = tokio.apiKey;
    for (const t of [lima, tokio]) {
      await saveMailSettings(pool, Buffer.from(KEY_B64, 'base64'), t.tenant.id, { host: '127.0.0.1', port: smtp.port, fromEmail: `avisos@${t.tenant.name}.test` });
    }
    storageDir = await mkdtemp(join(tmpdir(), 'fes-tz-'));
    app = await makeApp({ DATABASE_URL: URL_DB, TOKEN_SECRET: 't'.repeat(40), PUBLIC_BASE_URL: 'https://firma.test', NODE_ENV: 'test', SECRETS_KEY: KEY_B64, STORAGE_DIR: storageDir, ALLOW_DEV_OTP: 'true' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await smtp?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('por defecto es America/Lima; /me y ajustes la devuelven', async () => {
    expect((await http().get('/v1/me').set('X-Api-Key', keyLima)).body.timezone).toBe('America/Lima');
    expect((await http().get('/v1/settings').set('X-Api-Key', keyLima)).body.timezone).toBe('America/Lima');
    expect((await http().get('/v1/settings').set('X-Api-Key', keyTokio)).body.timezone).toBe('Asia/Tokyo');
  });

  it('solo acepta zonas IANA que existen; un valor inválido no cambia nada', async () => {
    for (const mala of ['-05', 'lima', 'America/Ciudad_Inventada', '']) {
      const r = await http().put('/v1/settings').set('X-Api-Key', keyLima).send({ privacyNotice: null, timezone: mala });
      expect(r.status).toBe(422);
    }
    expect((await http().get('/v1/settings').set('X-Api-Key', keyLima)).body.timezone).toBe('America/Lima');
  });

  it('editar solo el aviso no toca la zona; cambiarla sí', async () => {
    const aviso = await http().put('/v1/settings').set('X-Api-Key', keyLima).send({ privacyNotice: 'Aviso' });
    expect(aviso.body).toMatchObject({ privacyNotice: 'Aviso', timezone: 'America/Lima' });
    const cambio = await http().put('/v1/settings').set('X-Api-Key', keyLima).send({ privacyNotice: 'Aviso', timezone: 'America/Bogota' });
    expect(cambio.body.timezone).toBe('America/Bogota');
    await http().put('/v1/settings').set('X-Api-Key', keyLima).send({ privacyNotice: 'Aviso', timezone: 'America/Lima' });
  });

  it('el correo del enlace dice cuándo vence en la zona de la corredora, con el desfase', async () => {
    const mail = async (key: string, to: string) => {
      const antes = smtp.mails.length;
      const r = await http().post('/v1/requests').set('X-Api-Key', key).send(solicitud(to));
      expect(r.status).toBe(201);
      const fin = Date.now() + 4000;
      while (Date.now() < fin && smtp.mails.length === antes) await new Promise((x) => setTimeout(x, 50));
      return smtp.mails.slice(antes).find((m) => m.to.includes(to))?.text ?? '';
    };
    expect(await mail(keyLima, 'ana-lima@example.com')).toMatch(/El enlace vence el \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(UTC-5\)\./);
    expect(await mail(keyTokio, 'ana-tokio@example.com')).toMatch(/El enlace vence el \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(UTC\+9\)\./);
  });

  it('el runtime solo puede cambiar el aviso y la zona de su fila, no otras columnas de tenants', async () => {
    const u = new URL(URL_DB);
    u.username = 'firma_runtime';
    u.password = '';
    const rt = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL ?? u.toString() });
    try {
      const c = await rt.connect();
      try {
        const id = (await pool.query("SELECT id FROM tenants WHERE name = 'Lima'")).rows[0].id;
        await c.query("SELECT set_config('app.current_tenant', $1, false)", [id]);
        await expect(c.query("UPDATE tenants SET api_key_hash = 'x' WHERE id = $1", [id])).rejects.toMatchObject({ code: '42501' });
        await expect(c.query("UPDATE tenants SET active = false WHERE id = $1", [id])).rejects.toMatchObject({ code: '42501' });
        await c.query("UPDATE tenants SET timezone = 'America/Lima' WHERE id = $1", [id]);
      } finally {
        c.release();
      }
    } finally {
      await rt.end();
    }
  });
});
