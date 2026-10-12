/**
 * Eliminación de fotos a pedido del titular (cancelación de datos): borra los archivos, deja constancia de quién y por qué, y
 * NO toca el PDF firmado ni su evidencia. Requiere TEST_DATABASE_URL.
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
import { StorageService } from '../storage/storage.service';
import { createTenant } from '../tenants/tenants.service';
import { publishTemplate } from '../tenants/templates.service';
import { makeApp, resetDatabase, testDatabaseUrl } from '../test-utils';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const PASS = 'Contrasena-Segura-123';
const BLOCKS = [
  { id: 'p', type: 'paragraph', text: 'Yo, **{{signer.name}}**, acepto.' },
  { id: 's', type: 'signatureStamp' },
];

describe('eliminar fotos a pedido del titular', () => {
  let app: INestApplication;
  let pool: Pool;
  let storage: StorageService;
  let storageDir: string;
  let keyA: string;
  let keyB: string;
  let tenantA: string;
  let adminToken: string;
  let reviewerToken: string;

  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function usuario(role: 'ADMIN' | 'REVIEWER', email: string, tenant: string) {
    const u = await insertUser(pool, { tenantId: tenant, email, name: `Usuario ${role}`, role });
    await pool.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, await hashPassword(PASS)]);
    return ((await http().post('/v1/auth/login').send({ email, password: PASS })).body.accessToken as string);
  }

  /** Firma una solicitud y deja tres «fotos» en disco, como si el firmante las hubiera mandado. */
  async function firmadaConFotos(key: string, tenant: string) {
    const c = await http()
      .post('/v1/requests')
      .set('X-Api-Key', key)
      .send({
        documentType: 'APPOINTMENT_LETTER',
        externalRef: `r-${randomBytes(4).toString('hex')}`,
        signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
        data: { insurances: ['SCTR'] },
        otp: { channel: 'EMAIL', to: 'ana@example.com' },
        delivery: { mode: 'HOST' },
      });
    const token = (c.body.signUrl as string).split('/s/')[1];
    const otp = await http().post(`/v1/sign/${token}/otp`);
    const v = await http().post(`/v1/sign/${token}/verify`).send({ code: otp.body.devCode });
    const res = await http().post(`/v1/sign/${token}/submit`).set('X-Session', v.body.sessionToken).field('accepted', 'true').field('form', JSON.stringify({ powers: [], observation: '', consents: [] }));
    expect(res.status).toBe(200);
    const id = c.body.id as string;
    const paths = { photo: `${tenant}/${id}/photo.jpg`, id: `${tenant}/${id}/id.jpg`, back: `${tenant}/${id}/back.jpg` };
    for (const p of Object.values(paths)) await storage.put(p, Buffer.from('imagen de prueba'));
    await pool.query('UPDATE signature_evidence SET photo_path = $2, id_photo_path = $3, id_back_path = $4 WHERE request_id = $1', [id, paths.photo, paths.id, paths.back]);
    return { id, paths };
  }

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    const a = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'A SAC' });
    const b = await createTenant(pool, { name: 'B', country: 'PE', legalName: 'B SAC' });
    keyA = a.apiKey;
    keyB = b.apiKey;
    tenantA = a.tenant.id;
    await publishTemplate(pool, tenantA, 'APPOINTMENT_LETTER', { blocks: BLOCKS, clauseText: 'Acepto.', otpRequired: true, photoRequired: false, photoChallengeRequired: false, idPhotoRequired: false, idPhotoBackRequired: false, reviewRequired: false, publishedBy: 'prueba' });
    storageDir = await mkdtemp(join(tmpdir(), 'fes-purge-'));
    app = await makeApp({ DATABASE_URL: URL_DB, TOKEN_SECRET: 't'.repeat(40), PUBLIC_BASE_URL: 'https://firma.test', NODE_ENV: 'test', SECRETS_KEY: KEY_B64, STORAGE_DIR: storageDir, ALLOW_DEV_OTP: 'true' });
    storage = app.get(StorageService);
    adminToken = await usuario('ADMIN', 'admin@a.test', tenantA);
    reviewerToken = await usuario('REVIEWER', 'revisor@a.test', tenantA);
    expect(keyB).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('borra los archivos y deja constancia de quién y por qué; el PDF y su sello siguen intactos', async () => {
    const { id, paths } = await firmadaConFotos(keyA, tenantA);
    const antes = (await pool.query('SELECT pdf_path, pdf_sha256 FROM signature_requests WHERE id = $1', [id])).rows[0];
    const r = await http().post(`/v1/requests/${id}/purge-photos`).set(bearer(adminToken)).send({ reason: 'El titular pidió la cancelación de sus datos' });
    expect(r.status).toBe(200);
    expect(r.body.files).toBe(3);
    for (const p of Object.values(paths)) await expect(storage.get(p)).rejects.toThrow();
    const ev = (await pool.query('SELECT photo_path, id_photo_path, id_back_path, photo_deleted_at FROM signature_evidence WHERE request_id = $1', [id])).rows[0];
    expect(ev).toMatchObject({ photo_path: null, id_photo_path: null, id_back_path: null });
    expect(ev.photo_deleted_at).toBeTruthy();
    const log = (await pool.query("SELECT detail FROM access_log WHERE request_id = $1 AND event = 'photos_deleted_on_request'", [id])).rows[0];
    expect(log.detail).toMatchObject({ by: expect.stringContaining('admin@a.test'), reason: 'El titular pidió la cancelación de sus datos', files: 3 });
    // El PDF firmado y su huella NO cambian.
    const despues = (await pool.query('SELECT pdf_path, pdf_sha256 FROM signature_requests WHERE id = $1', [id])).rows[0];
    expect(despues).toEqual(antes);
    expect((await storage.get(despues.pdf_path)).length).toBeGreaterThan(0);
    // La integridad de la firma sigue en pie.
    const evid = await http().get(`/v1/requests/${id}/evidence`).set(bearer(adminToken));
    expect(evid.body.integrity.pdfIntact).toBe(true);
    expect(evid.body.integrity.seal.valid).toBe(true);
  });

  it('repetirlo no hace nada nuevo: 409', async () => {
    const { id } = await firmadaConFotos(keyA, tenantA);
    expect((await http().post(`/v1/requests/${id}/purge-photos`).set(bearer(adminToken)).send({ reason: 'Pedido del titular' })).status).toBe(200);
    const otra = await http().post(`/v1/requests/${id}/purge-photos`).set(bearer(adminToken)).send({ reason: 'Pedido del titular' });
    expect(otra.status).toBe(409);
    expect(otra.body.code).toBe('PHOTOS_ALREADY_DELETED');
  });

  it('exige un motivo; sin él no se borra nada', async () => {
    const { id, paths } = await firmadaConFotos(keyA, tenantA);
    for (const body of [{}, { reason: '' }, { reason: 'x' }, { reason: 'a'.repeat(501) }, { reason: 'Motivo válido', otro: 1 }]) {
      expect((await http().post(`/v1/requests/${id}/purge-photos`).set(bearer(adminToken)).send(body)).status).toBe(422);
    }
    expect((await storage.get(paths.photo)).length).toBeGreaterThan(0);
  });

  it('solo un administrador: el revisor recibe 403', async () => {
    const { id, paths } = await firmadaConFotos(keyA, tenantA);
    expect((await http().post(`/v1/requests/${id}/purge-photos`).set(bearer(reviewerToken)).send({ reason: 'Pedido del titular' })).status).toBe(403);
    expect((await storage.get(paths.photo)).length).toBeGreaterThan(0);
  });

  it('una corredora no puede borrar las fotos de otra: 404', async () => {
    const { id, paths } = await firmadaConFotos(keyA, tenantA);
    expect((await http().post(`/v1/requests/${id}/purge-photos`).set('X-Api-Key', keyB).send({ reason: 'Pedido del titular' })).status).toBe(404);
    expect((await storage.get(paths.photo)).length).toBeGreaterThan(0);
  });

  it('con la clave de API de la integración también se puede, y queda registrado como tal', async () => {
    const { id } = await firmadaConFotos(keyA, tenantA);
    expect((await http().post(`/v1/requests/${id}/purge-photos`).set('X-Api-Key', keyA).send({ reason: 'Pedido del titular' })).status).toBe(200);
    const log = (await pool.query("SELECT detail FROM access_log WHERE request_id = $1 AND event = 'photos_deleted_on_request'", [id])).rows[0];
    expect(log.detail.by).toBe('clave de API');
  });
});
