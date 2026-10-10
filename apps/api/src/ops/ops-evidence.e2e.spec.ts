/**
 * Comandos de operación: respaldo con manifiesto y verificación masiva de firmas. Requiere TEST_DATABASE_URL y pg_dump.
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { StorageService } from '../storage/storage.service';
import { createTenant } from '../tenants/tenants.service';
import { publishTemplate } from '../tenants/templates.service';
import { makeApp, resetDatabase, testDatabaseUrl } from '../test-utils';
import { runBackup, verifyBackup } from './backup';
import { verifyAll } from './verify-evidence';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');

describe('operación: respaldo y verificación de firmas', () => {
  let app: INestApplication;
  let pool: Pool;
  let storage: StorageService;
  let storageDir: string;
  let outDir: string;
  let tenantId: string;
  let requestId: string;

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    const t = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A SAC' });
    tenantId = t.tenant.id;
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', {
      blocks: [
        { id: 'p', type: 'paragraph', text: 'Yo, **{{signer.name}}**, acepto.' },
        { id: 's', type: 'signatureStamp' },
      ],
      clauseText: 'Acepto firmar electrónicamente.',
      otpRequired: true,
      photoRequired: false,
      photoChallengeRequired: false,
      idPhotoRequired: false,
      idPhotoBackRequired: false,
      reviewRequired: false,
      publishedBy: 'prueba',
    });
    storageDir = await mkdtemp(join(tmpdir(), 'fes-ops-st-'));
    outDir = await mkdtemp(join(tmpdir(), 'fes-ops-out-'));
    app = await makeApp({
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      SECRETS_KEY: KEY_B64,
      STORAGE_DIR: storageDir,
      ALLOW_DEV_OTP: 'true',
    });
    storage = app.get(StorageService);

    const http = () => request(app.getHttpServer());
    const c = await http()
      .post('/v1/requests')
      .set({ 'X-Api-Key': t.apiKey })
      .send({
        documentType: 'APPOINTMENT_LETTER',
        externalRef: 'ops-1',
        signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
        data: { insurances: ['SCTR'] },
        otp: { channel: 'EMAIL', to: 'ana@example.com' },
        delivery: { mode: 'HOST' },
      });
    expect(c.status).toBe(201);
    requestId = c.body.id;
    const token = (c.body.signUrl as string).split('/s/')[1];
    const otp = await http().post(`/v1/sign/${token}/otp`);
    const v = await http().post(`/v1/sign/${token}/verify`).send({ code: otp.body.devCode });
    const res = await http()
      .post(`/v1/sign/${token}/submit`)
      .set('X-Session', v.body.sessionToken)
      .field('accepted', 'true')
      .field('form', JSON.stringify({ powers: [], observation: '', consents: [] }));
    expect(res.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    for (const d of [storageDir, outDir]) if (d) await rm(d, { recursive: true, force: true });
  });

  it('verifyAll: una firma intacta se cuenta como íntegra', async () => {
    const s = await verifyAll(pool, storage, { tenantId });
    expect(s).toMatchObject({ total: 1, ok: 1, unsealed: 0, failed: [] });
  });

  it('el respaldo trae la base, los archivos y un manifiesto que se comprueba', async () => {
    const { dir, manifest } = await runBackup({ databaseUrl: URL_DB, storageDir, outDir });
    expect(manifest.storage.files).toBeGreaterThan(0);
    expect(manifest.database.bytes).toBeGreaterThan(0);
    expect(manifest.note).toMatch(/SECRETS_KEY/);
    const check = await verifyBackup(dir);
    expect(check).toMatchObject({ ok: true, problems: [] });
    expect(check.checked).toBe(Object.keys(manifest.files).length);
  }, 60_000);

  it('un archivo cambiado, borrado o añadido en el respaldo se detecta', async () => {
    const { dir, manifest } = await runBackup({ databaseUrl: URL_DB, storageDir, outDir, now: new Date(Date.now() + 5000) });
    const [first] = Object.keys(manifest.files).filter((f) => f.startsWith('storage/'));
    await appendFile(join(dir, first), 'x');
    await writeFile(join(dir, 'storage', 'intruso.bin'), 'x');
    const check = await verifyBackup(dir);
    expect(check.ok).toBe(false);
    expect(check.problems.join('\n')).toMatch(/cambió/);
    expect(check.problems.join('\n')).toMatch(/intruso\.bin: no figura/);
    await rm(join(dir, 'base.dump'));
    expect((await verifyBackup(dir)).problems.join('\n')).toMatch(/base\.dump: falta/);
  }, 60_000);

  it('--keep conserva solo los respaldos más nuevos', async () => {
    const out = await mkdtemp(join(tmpdir(), 'fes-ops-keep-'));
    try {
      for (let i = 0; i < 3; i++) await runBackup({ databaseUrl: URL_DB, storageDir, outDir: out, keep: 2, now: new Date(Date.UTC(2030, 0, 1 + i)) });
      expect((await readdir(out)).sort()).toEqual(['20300102-000000', '20300103-000000']);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 90_000);

  it('verifyAll: un PDF alterado en disco se informa como problema', async () => {
    const { rows } = await pool.query('SELECT pdf_path FROM signature_requests WHERE id=$1', [requestId]);
    const original = await storage.get(rows[0].pdf_path);
    await storage.put(rows[0].pdf_path, Buffer.concat([original, Buffer.from('\n%alterado')]));
    const s = await verifyAll(pool, storage, { tenantId });
    expect(s.ok).toBe(0);
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0].pdfIntact).toBe(false);
    await storage.put(rows[0].pdf_path, original);
  });
});
