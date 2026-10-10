/**
 * Integridad de la firma de punta a punta: PDF sellado, sello de tiempo de un tercero, bitácora encadenada e inalterable,
 * evidencia protegida, paquete de evidencia y revisión que retiene la copia. Requiere TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { unzipSync } from 'fflate';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { saveMailSettings } from '../mail/mail.service';
import { StorageService } from '../storage/storage.service';
import { createTenant } from '../tenants/tenants.service';
import { publishTemplate } from '../tenants/templates.service';
import { CapturedMail, FakeTsa, makeApp, resetDatabase, rewritePast, startFakeTsa, startSmtp, testDatabaseUrl } from '../test-utils';
import { checkIntegrity } from './integrity';
import { verifySeal } from './seal';
import { SealService } from './seal.service';
import { parseTimestampResponse } from './tsa';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const SECRETS = Buffer.from(KEY_B64, 'base64');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const BLOCKS = [
  { id: 't', type: 'title', text: 'DOCUMENTO DE PRUEBA' },
  { id: 'p', type: 'paragraph', text: 'Yo, **{{signer.name}}**, acepto.' },
  { id: 's', type: 'signatureStamp' },
];

describe('integridad de la firma', () => {
  let app: INestApplication;
  let pool: Pool;
  let tsa: FakeTsa;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  let storage: StorageService;
  let storageDir: string;
  let keyA: string;
  let keyB: string;
  let tenantA: string;
  let tenantB: string;

  const http = () => request(app.getHttpServer());
  const as = (key: string) => ({ 'X-Api-Key': key });

  async function plantilla(tenantId: string, reviewRequired: boolean) {
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', {
      blocks: BLOCKS,
      clauseText: 'Acepto firmar electrónicamente.',
      otpRequired: true,
      photoRequired: false,
      photoChallengeRequired: false,
      idPhotoRequired: false,
      idPhotoBackRequired: false,
      reviewRequired,
      publishedBy: 'prueba',
    });
  }

  /** Crea una solicitud, la abre con el código y la firma. Devuelve lo que las pruebas necesitan. */
  async function firmar(key: string, email = 'ana@example.com') {
    const c = await http()
      .post('/v1/requests')
      .set(as(key))
      .send({
        documentType: 'APPOINTMENT_LETTER',
        externalRef: `r-${randomBytes(4).toString('hex')}`,
        signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
        data: { insurances: ['SCTR'] },
        otp: { channel: 'EMAIL', to: email },
        delivery: { mode: 'HOST' },
      });
    expect(c.status).toBe(201);
    const token = (c.body.signUrl as string).split('/s/')[1];
    const antes = smtp.mails.length;
    const otp = await http().post(`/v1/sign/${token}/otp`);
    let code: string | undefined = otp.body.devCode;
    if (!code) {
      expect(await esperar(async () => smtp.mails.length > antes)).toBe(true);
      code = /(\d{6})/.exec(smtp.mails[smtp.mails.length - 1].text)?.[1];
    }
    const v = await http().post(`/v1/sign/${token}/verify`).send({ code });
    const session = v.body.sessionToken as string;
    expect(session).toBeDefined();
    const res = await http()
      .post(`/v1/sign/${token}/submit`)
      .set('X-Session', session)
      .field('accepted', 'true')
      .field('form', JSON.stringify({ powers: [], observation: '', consents: [] }));
    return { id: c.body.id as string, token, session, res };
  }

  const row = async (id: string) =>
    (await pool.query(`SELECT pdf_path, pdf_sha256, seal_cert_sha256, tsa_path, tsa_at, tsa_attempts, status FROM signature_requests WHERE id=$1`, [id])).rows[0];

  async function esperar(cond: () => Promise<boolean>, ms = 4000) {
    const fin = Date.now() + ms;
    while (Date.now() < fin) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    tsa = await startFakeTsa();
    smtp = await startSmtp();
    const a = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A SAC', registryCode: 'J701' });
    const b = await createTenant(pool, { name: 'B', country: 'PE', legalName: 'Corredora B SAC' });
    keyA = a.apiKey;
    keyB = b.apiKey;
    tenantA = a.tenant.id;
    tenantB = b.tenant.id;
    await plantilla(tenantA, false);
    await plantilla(tenantB, true);
    await saveMailSettings(pool, SECRETS, tenantB, { host: '127.0.0.1', port: smtp.port, fromEmail: 'avisos@b.test' });
    storageDir = await mkdtemp(join(tmpdir(), 'fes-integ-'));
    app = await makeApp({
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      SECRETS_KEY: KEY_B64,
      STORAGE_DIR: storageDir,
      ALLOW_DEV_OTP: 'true',
      TSA_URL: tsa.url,
    });
    storage = app.get(StorageService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await smtp?.close();
    await tsa?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  describe('PDF sellado', () => {
    it('lo que se guarda es el PDF sellado: verifica, cubre todo el archivo y su huella es la registrada', async () => {
      const s = await firmar(keyA);
      expect(s.res.status).toBe(200);
      const r = await row(s.id);
      const pdf = await storage.get(r.pdf_path);
      expect(sha(pdf)).toBe(r.pdf_sha256);
      expect(s.res.body.pdfSha256).toBe(r.pdf_sha256);
      const v = verifySeal(pdf);
      expect(v).toMatchObject({ valid: true, coversWholeFile: true });
      expect(v.certificateSha256).toBe(r.seal_cert_sha256);
    });

    it('el host descarga el MISMO PDF sellado', async () => {
      const s = await firmar(keyA);
      const d = await http().get(`/v1/requests/${s.id}/document`).set(as(keyA)).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(d.status).toBe(200);
      expect(sha(d.body)).toBe((await row(s.id)).pdf_sha256);
      expect(verifySeal(d.body).valid).toBe(true);
    });

    it('todas las firmas de un servicio usan la misma llave, creada una sola vez', async () => {
      const a = await row((await firmar(keyA)).id);
      const b = await row((await firmar(keyA)).id);
      expect(a.seal_cert_sha256).toBe(b.seal_cert_sha256);
      expect((await pool.query('SELECT count(*)::int AS n FROM seal_keys WHERE active')).rows[0].n).toBe(1);
      // La llave privada no está en claro en la base.
      const k = (await pool.query('SELECT private_key_enc FROM seal_keys')).rows[0];
      expect(k.private_key_enc).not.toContain('PRIVATE KEY');
    });

    it('si el archivo guardado se altera, la comprobación lo detecta (huella y sello)', async () => {
      const s = await firmar(keyA);
      const r = await row(s.id);
      const original = await storage.get(r.pdf_path);
      const alterado = Buffer.from(original);
      alterado[120] = alterado[120] ^ 0x01;
      await storage.put(r.pdf_path, alterado);
      const rep = await checkIntegrity(pool, storage, s.id);
      expect(rep.ok).toBe(false);
      expect(rep.pdfIntact).toBe(false);
      expect(rep.seal.valid).toBe(false);
      expect(rep.problems.join(' ')).toMatch(/huella del PDF/);
      await storage.put(r.pdf_path, original);
      expect((await checkIntegrity(pool, storage, s.id)).ok).toBe(true);
    });

    it('una firma anterior al sello se informa como tal, sin sello', async () => {
      const s = await firmar(keyA);
      const r = await row(s.id);
      // Se reemplaza el PDF sellado por uno sin sello y se actualiza su huella, como una firma hecha antes del sello.
      const sinSello = Buffer.from(await (await import('pdf-lib')).PDFDocument.create().then((d) => (d.addPage(), d.save({ useObjectStreams: false }))));
      await storage.put(r.pdf_path, sinSello);
      await rewritePast(pool, 'UPDATE signature_requests SET pdf_sha256 = $2, seal_cert_sha256 = NULL WHERE id = $1', [s.id, sha(sinSello)]);
      const rep = await checkIntegrity(pool, storage, s.id);
      expect(rep.seal.present).toBe(false);
      expect(rep.ok).toBe(false);
      expect(rep.problems.join(' ')).toMatch(/anterior al sello/);
    });

    it('con una SECRETS_KEY distinta no se firma ni se crea otra llave en silencio: 503 y nada queda a medias', async () => {
      const otra = await makeApp({
        DATABASE_URL: URL_DB,
        TOKEN_SECRET: 't'.repeat(40),
        PUBLIC_BASE_URL: 'https://firma.test',
        NODE_ENV: 'test',
        SECRETS_KEY: randomBytes(32).toString('base64'),
        STORAGE_DIR: storageDir,
        ALLOW_DEV_OTP: 'true',
      });
      try {
        const antes = (await pool.query('SELECT count(*)::int AS n FROM seal_keys')).rows[0].n;
        const c = await request(otra.getHttpServer())
          .post('/v1/requests')
          .set(as(keyA))
          .send({
            documentType: 'APPOINTMENT_LETTER',
            externalRef: `x-${randomBytes(3).toString('hex')}`,
            signer: { name: 'Ana', documentType: 'DNI', documentNumber: '1' },
            data: { insurances: ['SCTR'] },
            otp: { channel: 'EMAIL', to: 'a@b.com' },
            delivery: { mode: 'HOST' },
          });
        const token = (c.body.signUrl as string).split('/s/')[1];
        const otp = await request(otra.getHttpServer()).post(`/v1/sign/${token}/otp`);
        const v = await request(otra.getHttpServer()).post(`/v1/sign/${token}/verify`).send({ code: otp.body.devCode });
        const r = await request(otra.getHttpServer())
          .post(`/v1/sign/${token}/submit`)
          .set('X-Session', v.body.sessionToken)
          .field('accepted', 'true')
          .field('form', JSON.stringify({ powers: [], observation: '', consents: [] }));
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('SEAL_NOT_AVAILABLE');
        expect((await pool.query('SELECT status FROM signature_requests WHERE id=$1', [c.body.id])).rows[0].status).toBe('PENDING');
        expect((await pool.query('SELECT count(*)::int AS n FROM seal_keys')).rows[0].n).toBe(antes);
      } finally {
        await otra.close();
      }
    });
  });

  describe('sello de tiempo de un tercero', () => {
    it('al firmar se pide y se guarda cifrado; la hora es la que certifica la autoridad', async () => {
      tsa.mode = 'ok';
      const s = await firmar(keyA);
      expect(await esperar(async () => (await row(s.id)).tsa_path !== null)).toBe(true);
      const r = await row(s.id);
      expect(r.tsa_at).toBeInstanceOf(Date);
      expect(Math.abs(r.tsa_at.getTime() - Date.now())).toBeLessThan(60_000);
      const token = parseTimestampResponse(await storage.get(r.tsa_path), r.pdf_sha256);
      expect(token.genTime.getTime()).toBe(r.tsa_at.getTime());
      const ev = (await pool.query(`SELECT event FROM access_log WHERE request_id=$1 ORDER BY id`, [s.id])).rows.map((x) => x.event);
      expect(ev).toContain('timestamped');
      expect((await checkIntegrity(pool, storage, s.id)).timestamp).toMatchObject({ present: true, valid: true });
    });

    it('si la autoridad no responde, la firma IGUAL queda hecha y se reintenta después', async () => {
      tsa.mode = 'fail';
      const s = await firmar(keyA);
      expect(s.res.status).toBe(200);
      expect(await esperar(async () => (await row(s.id)).tsa_attempts >= 1)).toBe(true);
      expect((await row(s.id)).tsa_path).toBeNull();
      const ev1 = (await pool.query(`SELECT event FROM access_log WHERE request_id=$1`, [s.id])).rows.map((x) => x.event);
      expect(ev1).toContain('timestamp_failed');

      // Todavía no toca reintentar (esperas crecientes): no lo intenta.
      tsa.mode = 'ok';
      const seal = app.get(SealService);
      const antes = tsa.requests;
      expect(await seal.retryPending()).toBe(0);
      expect(tsa.requests).toBe(antes);

      // Pasado el plazo, lo logra.
      await rewritePast(pool, `UPDATE signature_requests SET signed_at = signed_at - interval '2 minutes' WHERE id = $1`, [s.id]);
      expect(await seal.retryPending()).toBeGreaterThanOrEqual(1);
      expect((await row(s.id)).tsa_path).not.toBeNull();
    });

    it('una respuesta de OTRA huella o una respuesta rechazada no se aceptan como sello', async () => {
      for (const mode of ['wrong', 'denied'] as const) {
        tsa.mode = mode;
        const s = await firmar(keyA);
        expect(s.res.status).toBe(200);
        expect(await esperar(async () => (await row(s.id)).tsa_attempts >= 1)).toBe(true);
        expect((await row(s.id)).tsa_path).toBeNull();
      }
      tsa.mode = 'ok';
    });

    it('sin autoridad configurada la firma funciona y no se intenta nada', async () => {
      const sin = await makeApp({
        DATABASE_URL: URL_DB,
        TOKEN_SECRET: 't'.repeat(40),
        PUBLIC_BASE_URL: 'https://firma.test',
        NODE_ENV: 'test',
        SECRETS_KEY: KEY_B64,
        STORAGE_DIR: storageDir,
        ALLOW_DEV_OTP: 'true',
      });
      try {
        expect(sin.get(SealService).timestampEnabled).toBe(false);
        expect(await sin.get(SealService).retryPending()).toBe(0);
      } finally {
        await sin.close();
      }
    });
  });

  describe('bitácora encadenada e inalterable', () => {
    it('cada evento lleva la huella del anterior y la cadena de una firma verifica', async () => {
      const s = await firmar(keyA);
      const rows = (await pool.query('SELECT id, prev_hash, hash FROM access_log WHERE request_id=$1 ORDER BY id', [s.id])).rows;
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows[0].prev_hash).toBeNull();
      for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
      expect(new Set(rows.map((r) => r.hash)).size).toBe(rows.length);
      const v = (await pool.query('SELECT * FROM access_log_verify($1)', [s.id])).rows[0];
      expect(v).toMatchObject({ ok: true, broken_at: null, head: rows[rows.length - 1].hash });
    });

    it('la bitácora es de solo anexar: no se modifica ni se borra', async () => {
      const s = await firmar(keyA);
      await expect(pool.query(`UPDATE access_log SET event='otro' WHERE request_id=$1`, [s.id])).rejects.toThrow(/solo anexar/);
      await expect(pool.query(`DELETE FROM access_log WHERE request_id=$1`, [s.id])).rejects.toThrow(/solo anexar/);
    });

    it('si alguien con acceso a la base la altera por otra vía, la cadena lo delata y dice dónde', async () => {
      const s = await firmar(keyA);
      const mid = (await pool.query('SELECT id FROM access_log WHERE request_id=$1 ORDER BY id OFFSET 2 LIMIT 1', [s.id])).rows[0].id;
      const original = (await pool.query('SELECT detail FROM access_log WHERE id=$1', [mid])).rows[0].detail;
      const client = await pool.connect();
      try {
        await client.query('ALTER TABLE access_log DISABLE TRIGGER access_log_append_only_trg');
        await client.query(`UPDATE access_log SET detail = '{"alterado": true}' WHERE id = $1`, [mid]);
        await client.query('ALTER TABLE access_log ENABLE TRIGGER access_log_append_only_trg');
      } finally {
        client.release();
      }
      const v = (await pool.query('SELECT * FROM access_log_verify($1)', [s.id])).rows[0];
      expect(v.ok).toBe(false);
      expect(Number(v.broken_at)).toBe(Number(mid));
      const rep = await checkIntegrity(pool, storage, s.id);
      expect(rep.chain.ok).toBe(false);
      expect(rep.ok).toBe(false);
      expect(rep.problems.join(' ')).toMatch(/bitácora está alterada/);
      // Se restaura para no ensuciar las demás pruebas.
      const c2 = await pool.connect();
      try {
        await c2.query('ALTER TABLE access_log DISABLE TRIGGER access_log_append_only_trg');
        await c2.query('UPDATE access_log SET detail = $2 WHERE id = $1', [mid, original]);
        await c2.query('ALTER TABLE access_log ENABLE TRIGGER access_log_append_only_trg');
      } finally {
        c2.release();
      }
      expect((await pool.query('SELECT ok FROM access_log_verify($1)', [s.id])).rows[0].ok).toBe(true);
    });

    it('borrar un evento del medio también rompe la cadena', async () => {
      const s = await firmar(keyA);
      const mid = (await pool.query('SELECT id FROM access_log WHERE request_id=$1 ORDER BY id OFFSET 1 LIMIT 1', [s.id])).rows[0].id;
      const full = (await pool.query('SELECT *, at::text AS at_text, host(ip) AS ip_text FROM access_log WHERE id=$1', [mid])).rows[0];
      const c = await pool.connect();
      try {
        await c.query('ALTER TABLE access_log DISABLE TRIGGER access_log_append_only_trg');
        await c.query('DELETE FROM access_log WHERE id=$1', [mid]);
        expect((await c.query('SELECT ok FROM access_log_verify($1)', [s.id])).rows[0].ok).toBe(false);
        // Se repone la fila tal cual (con su huella original) para dejar la base como estaba.
        await c.query('ALTER TABLE access_log DISABLE TRIGGER access_log_chain_trg');
        await c.query(
          'INSERT INTO access_log (id, request_id, event, ip, user_agent, detail, at, prev_hash, hash) VALUES ($1,$2,$3,$4::inet,$5,$6,$7::timestamptz,$8,$9)',
          [full.id, full.request_id, full.event, full.ip_text, full.user_agent, full.detail === null ? null : JSON.stringify(full.detail), full.at_text, full.prev_hash, full.hash],
        );
        await c.query('ALTER TABLE access_log ENABLE TRIGGER access_log_chain_trg');
        await c.query('ALTER TABLE access_log ENABLE TRIGGER access_log_append_only_trg');
      } finally {
        c.release();
      }
      expect((await pool.query('SELECT ok FROM access_log_verify($1)', [s.id])).rows[0].ok).toBe(true);
    });

    it('veinte eventos a la vez sobre la misma solicitud no bifurcan la cadena', async () => {
      const s = await firmar(keyA);
      await Promise.all(Array.from({ length: 20 }, (_, i) => pool.query(`INSERT INTO access_log (request_id, event, detail) VALUES ($1, 'prueba', $2)`, [s.id, JSON.stringify({ i })])));
      const v = (await pool.query('SELECT * FROM access_log_verify($1)', [s.id])).rows[0];
      expect(v.ok).toBe(true);
      expect(v.events).toBeGreaterThanOrEqual(24);
    });

    it('las cadenas de dos solicitudes son independientes', async () => {
      const a = await firmar(keyA);
      const b = await firmar(keyB);
      const ra = (await pool.query('SELECT hash FROM access_log WHERE request_id=$1 ORDER BY id LIMIT 1', [a.id])).rows[0];
      const rb = (await pool.query('SELECT prev_hash FROM access_log WHERE request_id=$1 ORDER BY id LIMIT 1', [b.id])).rows[0];
      expect(rb.prev_hash).toBeNull();
      expect(ra.hash).not.toBeNull();
    });
  });

  describe('la evidencia firmada no se edita', () => {
    it('la evidencia no cambia ni se borra, salvo lo que la operación normal escribe (revisión y fotos vencidas)', async () => {
      const s = await firmar(keyA);
      await expect(pool.query(`UPDATE signature_evidence SET form_json = '{"x":1}' WHERE request_id=$1`, [s.id])).rejects.toThrow(/no se modifica/);
      await expect(pool.query(`UPDATE signature_evidence SET clause_text = 'otra' WHERE request_id=$1`, [s.id])).rejects.toThrow(/no se modifica/);
      await expect(pool.query(`UPDATE signature_evidence SET ip = '1.2.3.4' WHERE request_id=$1`, [s.id])).rejects.toThrow(/no se modifica/);
      await expect(pool.query(`DELETE FROM signature_evidence WHERE request_id=$1`, [s.id])).rejects.toThrow(/no se borra/);
      await pool.query(`UPDATE signature_evidence SET review_note = 'ok' WHERE request_id=$1`, [s.id]);
      await pool.query(`UPDATE signature_evidence SET photo_deleted_at = now(), photo_path = NULL WHERE request_id=$1`, [s.id]);
    });

    it('una solicitud firmada no se modifica ni se borra; el sello de tiempo sí se puede registrar', async () => {
      const s = await firmar(keyA);
      await expect(pool.query(`UPDATE signature_requests SET snapshot = '{}' WHERE id=$1`, [s.id])).rejects.toThrow(/no se modifica/);
      await expect(pool.query(`UPDATE signature_requests SET pdf_sha256 = repeat('a',64) WHERE id=$1`, [s.id])).rejects.toThrow(/no se modifica/);
      await expect(pool.query(`UPDATE signature_requests SET status = 'REVOKED' WHERE id=$1`, [s.id])).rejects.toThrow(/no se modifica/);
      await expect(pool.query(`DELETE FROM signature_requests WHERE id=$1`, [s.id])).rejects.toThrow(/no se borra/);
      await pool.query(`UPDATE signature_requests SET tsa_attempts = tsa_attempts + 1 WHERE id=$1`, [s.id]);
    });

    it('una solicitud pendiente sigue pudiéndose actualizar (vencer, revocar)', async () => {
      const c = await http()
        .post('/v1/requests')
        .set(as(keyA))
        .send({
          documentType: 'APPOINTMENT_LETTER',
          externalRef: `p-${randomBytes(3).toString('hex')}`,
          signer: { name: 'Ana', documentType: 'DNI', documentNumber: '1' },
          data: { insurances: ['SCTR'] },
          delivery: { mode: 'HOST' },
          otp: { channel: 'EMAIL', to: 'a@b.com' },
        });
      await pool.query(`UPDATE signature_requests SET expires_at = now() + interval '1 day' WHERE id=$1`, [c.body.id]);
      expect((await http().post(`/v1/requests/${c.body.id}/revoke`).set(as(keyA)).send({})).status).toBe(200);
    });
  });

  describe('paquete de evidencia', () => {
    it('es un ZIP con todo lo necesario y se verifica sin el servicio', async () => {
      tsa.mode = 'ok';
      const s = await firmar(keyA);
      await esperar(async () => (await row(s.id)).tsa_path !== null);
      const r = await http().get(`/v1/requests/${s.id}/evidence-package`).set(as(keyA)).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('application/zip');
      expect(r.headers['content-disposition']).toMatch(/attachment; filename="FE-.*-evidencia\.zip"/);

      const files = unzipSync(new Uint8Array(r.body));
      expect(Object.keys(files).sort()).toEqual(
        ['LEEME.txt', 'certificado-del-servicio.pem', 'documento-firmado.pdf', 'evidencia.json', 'manifiesto.sha256', 'sello-de-tiempo.tsr'].sort(),
      );

      // El manifiesto cuadra con cada archivo.
      for (const line of Buffer.from(files['manifiesto.sha256']).toString('utf8').trim().split('\n')) {
        const [h, name] = line.split(/\s{2}/);
        expect(sha(files[name])).toBe(h);
      }
      // El PDF del paquete verifica por sí solo y su huella es la registrada.
      const pdf = Buffer.from(files['documento-firmado.pdf']);
      const rr = await row(s.id);
      expect(sha(pdf)).toBe(rr.pdf_sha256);
      expect(verifySeal(pdf).valid).toBe(true);
      // El certificado incluido tiene la huella registrada, y el sello de tiempo es de este PDF.
      const { certificateFingerprint } = await import('./seal');
      expect(certificateFingerprint(Buffer.from(files['certificado-del-servicio.pem']).toString('utf8'))).toBe(rr.seal_cert_sha256);
      expect(parseTimestampResponse(Buffer.from(files['sello-de-tiempo.tsr']), rr.pdf_sha256).genTime.getTime()).toBe(rr.tsa_at.getTime());

      const ev = JSON.parse(Buffer.from(files['evidencia.json']).toString('utf8'));
      expect(ev.referencia).toMatch(/^FE-/);
      expect(ev.firmante).toMatchObject({ name: 'Ana Pérez', documentNumber: '12345678' });
      expect(ev.pdfSha256).toBe(rr.pdf_sha256);
      expect(ev.verificacionAlGenerarElPaquete.ok).toBe(true);
      expect(ev.bitacora.length).toBeGreaterThanOrEqual(4);
      expect(ev.bitacora[0].huellaAnterior).toBeNull();
      for (let i = 1; i < ev.bitacora.length; i++) expect(ev.bitacora[i].huellaAnterior).toBe(ev.bitacora[i - 1].huella);
      expect(Buffer.from(files['LEEME.txt']).toString('utf8')).toContain(rr.pdf_sha256);
    });

    it('sin sello de tiempo, el paquete lo dice y no lo incluye', async () => {
      tsa.mode = 'fail';
      const s = await firmar(keyA);
      await esperar(async () => (await row(s.id)).tsa_attempts >= 1);
      const r = await http().get(`/v1/requests/${s.id}/evidence-package`).set(as(keyA)).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      const files = unzipSync(new Uint8Array(r.body));
      expect(files['sello-de-tiempo.tsr']).toBeUndefined();
      expect(Buffer.from(files['LEEME.txt']).toString('utf8')).toContain('todavía no tiene sello de tiempo');
      tsa.mode = 'ok';
    });

    it('otro tenant no lo obtiene (404) y una solicitud sin firmar da 409', async () => {
      const s = await firmar(keyA);
      expect((await http().get(`/v1/requests/${s.id}/evidence-package`).set(as(keyB))).status).toBe(404);
      expect((await http().get(`/v1/requests/${s.id}/evidence-package`)).status).toBe(401);
      const p = await http()
        .post('/v1/requests')
        .set(as(keyA))
        .send({
          documentType: 'APPOINTMENT_LETTER',
          externalRef: `u-${randomBytes(3).toString('hex')}`,
          signer: { name: 'Ana', documentType: 'DNI', documentNumber: '1' },
          data: { insurances: ['SCTR'] },
          delivery: { mode: 'HOST' },
          otp: { channel: 'EMAIL', to: 'a@b.com' },
        });
      expect((await http().get(`/v1/requests/${p.body.id}/evidence-package`).set(as(keyA))).status).toBe(409);
      expect((await http().get(`/v1/requests/no-es-un-id/evidence-package`).set(as(keyA))).status).toBe(404);
    });

    it('la evidencia que ve el panel trae la verificación de integridad', async () => {
      const s = await firmar(keyA);
      const e = await http().get(`/v1/requests/${s.id}/evidence`).set(as(keyA));
      expect(e.status).toBe(200);
      expect(e.body.integrity).toMatchObject({ ok: true, pdfIntact: true, seal: { valid: true, coversWholeFile: true, matchesRecord: true }, chain: { ok: true } });
    });
  });

  describe('revisión de identidad que retiene la copia', () => {
    // Solo las COPIAS firmadas (el código de verificación también llega a ese correo, pero no cuenta).
    const correos = (): CapturedMail[] => smtp.mails.filter((m) => m.to === 'cliente@b.test' && /Su documento firmado/.test(m.subject));

    it('con revisión obligatoria, firmar NO entrega la copia: ni correo ni descarga', async () => {
      const antes = correos().length;
      const s = await firmar(keyB, 'cliente@b.test');
      expect(s.res.status).toBe(200);
      expect(s.res.body).toMatchObject({ emailed: false, awaitingReview: true });
      await new Promise((r) => setTimeout(r, 300));
      expect(correos().length).toBe(antes);
      const d = await http().get(`/v1/sign/${s.token}/document`).set('X-Session', s.session);
      expect(d.status).toBe(409);
      expect(d.body.code).toBe('REVIEW_PENDING');
    });

    it('rechazar la identidad mantiene la copia retenida', async () => {
      const antes = correos().length;
      const s = await firmar(keyB, 'cliente@b.test');
      const r = await http().post(`/v1/requests/${s.id}/review`).set(as(keyB)).send({ result: 'REJECTED', reviewedBy: 'Revisora', note: 'no coincide' });
      expect(r.status).toBe(200);
      await new Promise((r2) => setTimeout(r2, 300));
      expect(correos().length).toBe(antes);
      expect((await http().get(`/v1/sign/${s.token}/document`).set('X-Session', s.session)).body.code).toBe('REVIEW_PENDING');
    });

    it('verificar la identidad envía la copia (una sola vez) y libera la descarga', async () => {
      const antes = correos().length;
      const s = await firmar(keyB, 'cliente@b.test');
      const v1 = await http().post(`/v1/requests/${s.id}/review`).set(as(keyB)).send({ result: 'VERIFIED', reviewedBy: 'Revisora' });
      expect(v1.status).toBe(200);
      expect(await esperar(async () => correos().length === antes + 1)).toBe(true);
      const mail = correos()[correos().length - 1];
      expect(mail.subject).toMatch(/Su documento firmado FE-/);
      expect(mail.raw).toContain('application/pdf');
      const ev = (await pool.query(`SELECT event FROM access_log WHERE request_id=$1`, [s.id])).rows.map((x) => x.event);
      expect(ev).toContain('confirmation_sent');
      const d = await http().get(`/v1/sign/${s.token}/document`).set('X-Session', s.session);
      expect(d.status).toBe(200);

      // Volver a verificar no reenvía.
      await http().post(`/v1/requests/${s.id}/review`).set(as(keyB)).send({ result: 'VERIFIED', reviewedBy: 'Revisora' });
      await new Promise((r) => setTimeout(r, 300));
      expect(correos().length).toBe(antes + 1);
    });

    it('sin revisión obligatoria todo sigue igual: la descarga está disponible al firmar', async () => {
      const s = await firmar(keyA);
      expect(s.res.body.awaitingReview).toBe(false);
      expect((await http().get(`/v1/sign/${s.token}/document`).set('X-Session', s.session)).status).toBe(200);
    });
  });
});
