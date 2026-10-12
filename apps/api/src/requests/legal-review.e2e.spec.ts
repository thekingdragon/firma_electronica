/**
 * REQUIRE_LEGAL_REVIEW: con la opción encendida no se crean solicitudes con una plantilla que no pasó la revisión legal.
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
import { publishTemplate } from '../tenants/templates.service';
import { makeApp, resetDatabase, testDatabaseUrl } from '../test-utils';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const BODY = {
  documentType: 'APPOINTMENT_LETTER',
  externalRef: 'x-1',
  signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
  data: { insurances: ['SCTR'] },
  otp: { channel: 'EMAIL', to: 'ana@example.com' },
  delivery: { mode: 'HOST' },
};

describe('revisión legal obligatoria', () => {
  let pool: Pool;
  let estricta: INestApplication;
  let laxa: INestApplication;
  let storageDir: string;
  let key: string;
  let tenantId: string;

  const env = (extra: Record<string, string> = {}) => ({ DATABASE_URL: URL_DB, TOKEN_SECRET: 't'.repeat(40), PUBLIC_BASE_URL: 'https://firma.test', NODE_ENV: 'test', SECRETS_KEY: KEY_B64, STORAGE_DIR: storageDir, ...extra });
  const crear = (app: INestApplication, ref: string) => request(app.getHttpServer()).post('/v1/requests').set('X-Api-Key', key).send({ ...BODY, externalRef: ref });

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    storageDir = await mkdtemp(join(tmpdir(), 'fes-legal-'));
    const t = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A SAC' });
    key = t.apiKey;
    tenantId = t.tenant.id;
    estricta = await makeApp(env({ REQUIRE_LEGAL_REVIEW: 'true' }));
    laxa = await makeApp(env());
  }, 60_000);

  afterAll(async () => {
    await estricta?.close();
    await laxa?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('apagada (por defecto): se crea aunque el texto sea borrador', async () => {
    expect((await crear(laxa, 'a-1')).status).toBe(201);
  });

  it('encendida: una plantilla sin revisar se rechaza, con un código estable y sin crear nada', async () => {
    const antes = Number((await pool.query('SELECT count(*) FROM signature_requests')).rows[0].count);
    const r = await crear(estricta, 'b-1');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TEMPLATE_NOT_REVIEWED');
    expect(Number((await pool.query('SELECT count(*) FROM signature_requests')).rows[0].count)).toBe(antes);
  });

  it('encendida: al publicar el texto marcado como revisado, ya se crea', async () => {
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { legalReviewed: true, publishedBy: 'Abogada' });
    expect((await crear(estricta, 'c-1')).status).toBe(201);
  });

  it('volver a publicar sin marcarlo conserva la revisión; marcarlo como no revisado la quita', async () => {
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { publishedBy: 'Editor' });
    expect((await crear(estricta, 'd-1')).status).toBe(201);
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { legalReviewed: false, publishedBy: 'Editor' });
    expect((await crear(estricta, 'e-1')).status).toBe(409);
  });
});
