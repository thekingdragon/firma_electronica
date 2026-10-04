/**
 * Pruebas de integración de la firma: desafío de la foto, envío, evidencia, PDF cifrado, copia por
 * correo y descargas. Requieren TEST_DATABASE_URL (base que termine en _test).
 */
import { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { Pool } from 'pg';
import request from 'supertest';
import { makePng } from '../documents/image-fixtures';
import { saveMailSettings } from '../mail/mail.service';
import { StorageService } from '../storage/storage.service';
import { makeApp, resetDatabase, SmtpCapture, startSmtp, testDatabaseUrl } from '../test-utils';
import { createTenant } from '../tenants/tenants.service';

const URL = testDatabaseUrl();
const SECRETS_KEY = randomBytes(32);
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const FOTO = makePng(1280, 720);

const body = (email = 'ana@example.com', withOtp = true) => ({
  documentType: 'APPOINTMENT_LETTER',
  externalRef: 'cli-1',
  signer: { name: 'Ana Pérez Quispe', documentType: 'DNI', documentNumber: '12345678' },
  data: { insurances: ['SCTR Salud', 'SCTR Pensión'] },
  ...(withOtp ? { otp: { channel: 'EMAIL', to: email } } : {}),
  delivery: { mode: 'HOST' },
});

const FORM = { powers: ['GESTIONAR_SOLICITUD', 'RENOVACIONES'], observation: 'Solo para Ayacucho' };

describe('firma: foto, envío y evidencia', () => {
  let app: INestApplication;
  let noKeyApp: INestApplication;
  let pool: Pool;
  let smtp: SmtpCapture;
  let storageDir: string;
  let storage: StorageService;
  const tenants: Record<string, { key: string; id: string }> = {};

  async function mkTenant(name: string) {
    const t = await createTenant(pool, { name, country: 'PE', legalName: `${name} Corredores SAC`, registryCode: 'J-0001' });
    tenants[name] = { key: t.apiKey, id: t.tenant.id };
    return t.tenant.id;
  }

  const http = (a = app) => request(a.getHttpServer());
  /**
   * El código OTP del correo de ESTA solicitud. Se busca por su referencia: las confirmaciones de otras
   * pruebas salen en segundo plano y pueden llegar en cualquier momento, así que «el último correo»
   * no sirve.
   */
  const codeFor = (reference: string): string => {
    for (let i = smtp.mails.length - 1; i >= 0; i--) {
      const m = smtp.mails[i];
      if (!m.text.includes(reference)) continue;
      const code = /Su código de verificación es: (\d{6})/.exec(m.text)?.[1];
      if (code) return code;
    }
    throw new Error('No llegó el correo con el código de ' + reference);
  };

  /** Crea la solicitud y llega hasta tener sesión (OTP incluido). */
  async function conSesion(tenant = 'Firma', a = app) {
    const withOtp = tenant !== 'Sin otp';
    const created = await http(a).post('/v1/requests').set('X-Api-Key', tenants[tenant].key).send(body('ana@example.com', withOtp));
    expect(created.status).toBe(201);
    const token = (created.body.signUrl as string).split('/s/')[1];
    if (withOtp) await http(a).post(`/v1/sign/${token}/otp`).expect(200);
    const v = await http(a).post(`/v1/sign/${token}/verify`).send(withOtp ? { code: codeFor(created.body.reference) } : {}).expect(200);
    return { id: created.body.id as string, token, session: v.body.sessionToken as string, a };
  }

  async function desafio(s: { token: string; session: string; a: INestApplication }) {
    const r = await http(s.a).post(`/v1/sign/${s.token}/photo-challenge`).set('X-Session', s.session).expect(200);
    return r.body as { challengeId: string; code: string; expiresAt: string };
  }

  /** Envía la firma. Cada opción puede sobreescribirse o quitarse para probar un caso. */
  function enviar(
    s: { token: string; session: string; a: INestApplication },
    o: { photo?: Buffer | null; challengeId?: string | null; accepted?: string | null; form?: unknown; session?: string | null; clientInfo?: unknown } = {},
  ) {
    const r = http(s.a).post(`/v1/sign/${s.token}/submit`);
    const session = o.session === undefined ? s.session : o.session;
    if (session) r.set('X-Session', session);
    r.set('User-Agent', 'PruebaNavegador/2.0');
    if (o.accepted !== null) r.field('accepted', o.accepted ?? 'true');
    r.field('form', JSON.stringify(o.form ?? FORM));
    if (o.clientInfo !== undefined) r.field('clientInfo', JSON.stringify(o.clientInfo));
    if (o.challengeId) r.field('challengeId', o.challengeId);
    if (o.photo !== null) r.attach('photo', o.photo ?? FOTO, { filename: 'foto.png', contentType: 'image/png' });
    return r;
  }

  /** Flujo completo hasta enviar, con desafío vigente. */
  async function firmar(tenant = 'Firma') {
    const s = await conSesion(tenant);
    const d = await desafio(s);
    const res = await enviar(s, { challengeId: d.challengeId });
    return { ...s, d, res };
  }

  beforeAll(async () => {
    pool = await resetDatabase(URL);
    smtp = await startSmtp();
    storageDir = await mkdtemp(join(tmpdir(), 'fes-e2e-'));

    const firmaId = await mkTenant('Firma');
    await saveMailSettings(pool, SECRETS_KEY, firmaId, { host: '127.0.0.1', port: smtp.port, fromEmail: 'no-responder@corredora.test', fromName: 'Corredora' });

    const sinFotoId = await mkTenant('Sin foto');
    await saveMailSettings(pool, SECRETS_KEY, sinFotoId, { host: '127.0.0.1', port: smtp.port, fromEmail: 'no-responder@corredora.test' });
    await pool.query(`UPDATE document_templates SET photo_required=false, photo_challenge_required=false WHERE tenant_id=$1`, [sinFotoId]);

    const sinOtpId = await mkTenant('Sin otp');
    await pool.query(`UPDATE document_templates SET otp_required=false, photo_required=false, photo_challenge_required=false WHERE tenant_id=$1`, [sinOtpId]);

    await mkTenant('Otro');

    const env = {
      DATABASE_URL: URL,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      STORAGE_DIR: storageDir,
    };
    app = await makeApp({ ...env, SECRETS_KEY: SECRETS_KEY.toString('base64') });
    noKeyApp = await makeApp({ ...env, SECRETS_KEY: '' });
    storage = new StorageService({ storageDir, secretsKey: SECRETS_KEY } as never);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await noKeyApp?.close();
    await pool?.end();
    await smtp?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  describe('desafío de la foto', () => {
    it('emite un código de 4 dígitos que vence en 10 minutos', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      expect(d.code).toMatch(/^\d{4}$/);
      expect(d.challengeId).toMatch(/^[0-9a-f-]{36}$/);
      const min = (new Date(d.expiresAt).getTime() - Date.now()) / 60000;
      expect(min).toBeGreaterThan(9);
      expect(min).toBeLessThanOrEqual(10);
    });

    it('exige sesión verificada', async () => {
      const s = await conSesion();
      expect((await http().post(`/v1/sign/${s.token}/photo-challenge`)).status).toBe(401);
      expect((await http().post(`/v1/sign/${s.token}/photo-challenge`).set('X-Session', 'x.y')).status).toBe(401);
    });

    it('un código nuevo deja viejo al anterior (solo uno vivo)', async () => {
      const s = await conSesion();
      const a = await desafio(s);
      const b = await desafio(s);
      expect(b.challengeId).not.toBe(a.challengeId);
      const { rows } = await pool.query(
        `SELECT id, superseded_at IS NOT NULL AS viejo FROM photo_challenges WHERE request_id=$1 ORDER BY issued_at`,
        [s.id],
      );
      expect(rows.map((r) => r.viejo)).toEqual([true, false]);
    });

    it('tope de 10 por hora', async () => {
      const s = await conSesion();
      for (let i = 0; i < 10; i++) await desafio(s);
      const r = await http().post(`/v1/sign/${s.token}/photo-challenge`).set('X-Session', s.session);
      expect(r.status).toBe(429);
      expect(r.body.code).toBe('CHALLENGE_RATE_LIMITED');
    });

    it('si el tipo no lo exige: 409', async () => {
      const s = await conSesion('Sin foto');
      const r = await http().post(`/v1/sign/${s.token}/photo-challenge`).set('X-Session', s.session);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('CHALLENGE_NOT_REQUIRED');
    });
  });

  describe('firmar (camino feliz)', () => {
    it('firma, guarda todo cifrado y deja la evidencia completa', async () => {
      const { id, res, d } = await firmar();
      expect(res.status).toBe(200);
      expect(res.body.reference).toMatch(/^FE-\d{4}-/);
      expect(res.body.pdfSha256).toMatch(/^[0-9a-f]{64}$/);

      const req = (await pool.query(`SELECT status, signed_at, pdf_path, pdf_sha256 FROM signature_requests WHERE id=$1`, [id])).rows[0];
      expect(req.status).toBe('SIGNED');
      expect(req.signed_at).not.toBeNull();
      expect(req.pdf_sha256).toBe(res.body.pdfSha256);

      // El PDF en disco está cifrado; descifrado, es un PDF íntegro con el hash registrado.
      const crudo = await readFile(join(storageDir, req.pdf_path));
      expect(crudo.subarray(0, 4).toString()).toBe('FES1');
      expect(crudo.includes(Buffer.from('%PDF'))).toBe(false);
      const pdf = await storage.get(req.pdf_path);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(sha(pdf)).toBe(req.pdf_sha256);
      expect((await PDFDocument.load(pdf)).getPages().length).toBeGreaterThanOrEqual(2);

      const ev = (
        await pool.query(
          `SELECT otp_verified_at, otp_attempts, challenge_id, photo_received_at, photo_path, photo_sha256,
                  photo_width, photo_height, form_json, clause_text, ip::text AS ip, user_agent, client_info
             FROM signature_evidence WHERE request_id=$1`,
          [id],
        )
      ).rows[0];
      expect(ev.otp_verified_at).not.toBeNull();
      expect(ev.otp_attempts).toBe(1);
      expect(ev.challenge_id).toBe(d.challengeId);
      expect(ev.photo_received_at).not.toBeNull();
      expect(ev.photo_sha256).toBe(sha(FOTO));
      expect([ev.photo_width, ev.photo_height]).toEqual([1280, 720]);
      expect(ev.form_json).toEqual(FORM);
      expect(ev.clause_text).toContain('BORRADOR');
      expect(ev.ip).toMatch(/^127\.0\.0\.1/);
      expect(ev.user_agent).toBe('PruebaNavegador/2.0');

      // La foto también va cifrada, y descifrada es idéntica a la enviada.
      expect((await readFile(join(storageDir, ev.photo_path))).includes(FOTO.subarray(0, 64))).toBe(false);
      expect((await storage.get(ev.photo_path)).equals(FOTO)).toBe(true);

      // El desafío quedó consumido y la bitácora tiene la firma.
      expect((await pool.query('SELECT consumed_at FROM photo_challenges WHERE id=$1', [d.challengeId])).rows[0].consumed_at).not.toBeNull();
      const events = (await pool.query(`SELECT event FROM access_log WHERE request_id=$1`, [id])).rows.map((r) => r.event);
      expect(events).toContain('signed');
      expect(events).toContain('photo_challenge_issued');
    });

    it('el PDF refleja lo que el firmante marcó y el código del desafío', async () => {
      const { id, d } = await firmar();
      const path = (await pool.query('SELECT pdf_path FROM signature_requests WHERE id=$1', [id])).rows[0].pdf_path;
      const doc = await PDFDocument.load(await storage.get(path));
      expect(doc.getTitle()).toContain('CARTA DE NOMBRAMIENTO');
      expect(doc.getAuthor()).toBe('Firma Corredores SAC');
      expect(d.code).toMatch(/^\d{4}$/);
    });

    it('envía al firmante la copia por correo con el PDF adjunto', async () => {
      const { id } = await firmar();
      const reference = (await pool.query('SELECT reference FROM signature_requests WHERE id=$1', [id])).rows[0].reference as string;
      // El envío es en segundo plano y otras pruebas también mandan confirmaciones: se busca la de ESTA referencia.
      const buscar = () => smtp.mails.find((m) => m.subject.includes(reference));
      for (let i = 0; i < 50 && !buscar(); i++) await new Promise((r) => setTimeout(r, 100));
      const conf = buscar();
      expect(conf).toBeDefined();
      if (!conf) return;
      expect(conf.subject).toContain('Su documento firmado');
      expect(conf.to).toBe('ana@example.com');
      expect(conf.raw).toContain('application/pdf');
      expect(conf.raw).toMatch(/filename="?FE-\d{4}-/);
      const ev = (await pool.query(`SELECT event FROM access_log WHERE request_id=$1`, [id])).rows.map((r) => r.event);
      expect(ev).toContain('confirmation_sent');
    });

    it('tras firmar, el link ya no abre y no se puede firmar de nuevo', async () => {
      const { token, d, session, a } = await (async () => {
        const f = await firmar();
        return { token: f.token, d: f.d, session: f.session, a: f.a };
      })();
      const intro = await http().get(`/v1/sign/${token}`);
      expect(intro.status).toBe(410);
      expect(intro.body.code).toBe('ALREADY_SIGNED');
      const otra = await enviar({ token, session, a }, { challengeId: d.challengeId });
      expect(otra.status).toBe(410);
    });

    it('el firmante descarga su copia con su sesión; sin sesión no', async () => {
      const f = await firmar();
      const ok = await http().get(`/v1/sign/${f.token}/document`).set('X-Session', f.session);
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toBe('application/pdf');
      expect(Buffer.from(ok.body).subarray(0, 5).toString()).toBe('%PDF-');
      expect(sha(Buffer.from(ok.body))).toBe(f.res.body.pdfSha256);
      expect((await http().get(`/v1/sign/${f.token}/document`)).status).toBe(401);
    });

    it('antes de firmar no hay copia para descargar', async () => {
      const s = await conSesion();
      const r = await http().get(`/v1/sign/${s.token}/document`).set('X-Session', s.session);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('NOT_SIGNED');
    });

    it('guarda los datos informativos del navegador y descarta los que no son válidos', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      await enviar(s, { challengeId: d.challengeId, clientInfo: { timezone: 'America/Lima', language: 'es-PE', ancho: 390 } }).expect(200);
      const ci = (await pool.query('SELECT client_info FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0].client_info;
      expect(ci).toEqual({ timezone: 'America/Lima', language: 'es-PE', ancho: 390 });

      const s2 = await conSesion();
      const d2 = await desafio(s2);
      await enviar(s2, { challengeId: d2.challengeId, clientInfo: { anidado: { x: 1 } } }).expect(200);
      expect((await pool.query('SELECT client_info FROM signature_evidence WHERE request_id=$1', [s2.id])).rows[0].client_info).toEqual({});
    });
  });

  describe('validaciones (nada se guarda si algo falla)', () => {
    async function sinCambios(id: string) {
      const r = await pool.query(`SELECT status FROM signature_requests WHERE id=$1`, [id]);
      const e = await pool.query(`SELECT 1 FROM signature_evidence WHERE request_id=$1`, [id]);
      expect(r.rows[0].status).toBe('PENDING');
      expect(e.rowCount).toBe(0);
      const carpeta = join(storageDir, tenants['Firma'].id, id);
      await expect(readdir(carpeta)).rejects.toThrow();
    }

    it('sin aceptar la cláusula: 422', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      for (const accepted of [null, 'false', 'si']) {
        const r = await enviar(s, { challengeId: d.challengeId, accepted });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('ACCEPTANCE_REQUIRED');
      }
      await sinCambios(s.id);
    });

    it('formulario inválido: sin facultades ni observación, facultad inventada, campo extra, JSON roto', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      const casos = [{ powers: [], observation: '' }, { powers: ['INVENTADA'], observation: '' }, { powers: ['AJUSTADOR'], observation: '', x: 1 }, 'no es json'];
      for (const form of casos) {
        const r = await enviar(s, { challengeId: d.challengeId, form });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('VALIDATION_ERROR');
      }
      await sinCambios(s.id);
    });

    it('sin foto cuando es obligatoria: 422', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      const r = await enviar(s, { challengeId: d.challengeId, photo: null });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PHOTO_REQUIRED');
      await sinCambios(s.id);
    });

    it('un archivo que dice ser imagen pero no lo es: 422', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      const r = await enviar(s, { challengeId: d.challengeId, photo: Buffer.from('<script>alert(1)</script>'.repeat(200)) });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PHOTO_INVALID');
      await sinCambios(s.id);
    });

    it('una foto de baja resolución: 422 con el tamaño que llegó', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      const r = await enviar(s, { challengeId: d.challengeId, photo: makePng(640, 480) });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PHOTO_TOO_SMALL');
      expect(r.body.message).toContain('640×480');
      await sinCambios(s.id);
    });

    it('un archivo de más de 8 MB: 413', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      const grande = Buffer.concat([makePng(1280, 720), Buffer.alloc(9 * 1024 * 1024)]);
      const r = await enviar(s, { challengeId: d.challengeId, photo: grande });
      expect(r.status).toBe(413);
      await sinCambios(s.id);
    });

    it('sin sesión o con una de otra solicitud: 401', async () => {
      const a = await conSesion();
      const b = await conSesion();
      const d = await desafio(a);
      expect((await enviar(a, { challengeId: d.challengeId, session: null })).status).toBe(401);
      expect((await enviar(a, { challengeId: d.challengeId, session: b.session })).status).toBe(401);
      await sinCambios(a.id);
    });
  });

  describe('el código de la foto', () => {
    async function sinCambios(id: string) {
      expect((await pool.query(`SELECT status FROM signature_requests WHERE id=$1`, [id])).rows[0].status).toBe('PENDING');
    }

    it('sin challengeId o con uno inventado: 409', async () => {
      const s = await conSesion();
      await desafio(s);
      const sin = await enviar(s, {});
      expect(sin.status).toBe(409);
      expect(sin.body.code).toBe('CHALLENGE_INVALID');
      const falso = await enviar(s, { challengeId: '00000000-0000-4000-8000-000000000000' });
      expect(falso.status).toBe(409);
      await sinCambios(s.id);
    });

    it('un código reemplazado por uno nuevo ya no sirve', async () => {
      const s = await conSesion();
      const viejo = await desafio(s);
      const nuevo = await desafio(s);
      expect((await enviar(s, { challengeId: viejo.challengeId })).status).toBe(409);
      expect((await enviar(s, { challengeId: nuevo.challengeId })).status).toBe(200);
    });

    it('un código vencido: 409 CHALLENGE_EXPIRED', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      // Se mueve también la emisión: la base exige expires_at > issued_at.
      await pool.query(
        `UPDATE photo_challenges SET issued_at = now() - interval '11 minutes', expires_at = now() - interval '1 second' WHERE id=$1`,
        [d.challengeId],
      );
      const r = await enviar(s, { challengeId: d.challengeId });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('CHALLENGE_EXPIRED');
      await sinCambios(s.id);
    });

    it('el código de otra solicitud no sirve', async () => {
      const a = await conSesion();
      const b = await conSesion();
      const db = await desafio(b);
      await desafio(a);
      expect((await enviar(a, { challengeId: db.challengeId })).status).toBe(409);
    });

    it('un fallo de validación NO consume el código: se puede reintentar con el mismo', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      expect((await enviar(s, { challengeId: d.challengeId, photo: makePng(640, 480) })).status).toBe(422);
      expect((await enviar(s, { challengeId: d.challengeId, form: { powers: [], observation: '' } })).status).toBe(422);
      const ok = await enviar(s, { challengeId: d.challengeId });
      expect(ok.status).toBe(200);
    });

    it('un código ya usado no sirve para firmar otra vez', async () => {
      const f = await firmar();
      expect(f.res.status).toBe(200);
      const otra = await enviar(f, { challengeId: f.d.challengeId });
      expect(otra.status).toBe(410);
    });
  });

  describe('concurrencia e integridad', () => {
    it('dos envíos a la vez: UNA sola firma, una sola evidencia y un solo par de archivos', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      const [a, b] = await Promise.all([enviar(s, { challengeId: d.challengeId }), enviar(s, { challengeId: d.challengeId })]);
      expect([a.status, b.status].sort()).toEqual([200, 410]);
      expect((await pool.query('SELECT 1 FROM signature_evidence WHERE request_id=$1', [s.id])).rowCount).toBe(1);
      const files = await readdir(join(storageDir, tenants['Firma'].id, s.id));
      expect(files.sort()).toEqual(['document.bin', 'photo.bin']);
    });

    it('si revocan la solicitud mientras el firmante está en la pantalla, no puede firmar', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      await pool.query(`UPDATE signature_requests SET status='REVOKED' WHERE id=$1`, [s.id]);
      const r = await enviar(s, { challengeId: d.challengeId });
      expect(r.status).toBe(410);
      expect(r.body.code).toBe('LINK_REVOKED');
    });

    it('si el link vence mientras tanto, no puede firmar', async () => {
      const s = await conSesion();
      const d = await desafio(s);
      await pool.query(`UPDATE signature_requests SET expires_at = now() - interval '1 second' WHERE id=$1`, [s.id]);
      const r = await enviar(s, { challengeId: d.challengeId });
      expect(r.status).toBe(410);
      expect(r.body.code).toBe('LINK_EXPIRED');
    });
  });

  describe('políticas por tipo', () => {
    it('sin foto ni desafío por política: firma sin ellos y la evidencia lo refleja', async () => {
      const s = await conSesion('Sin foto');
      const r = await enviar(s, { photo: null });
      expect(r.status).toBe(200);
      const ev = (await pool.query('SELECT photo_path, photo_sha256, challenge_id, photo_received_at FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0];
      expect(ev).toEqual({ photo_path: null, photo_sha256: null, challenge_id: null, photo_received_at: null });
    });

    it('sin OTP ni foto por política: firma directo', async () => {
      const s = await conSesion('Sin otp');
      const r = await enviar(s, { photo: null });
      expect(r.status).toBe(200);
      const ev = (await pool.query('SELECT otp_verified_at, otp_attempts FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0];
      expect(ev.otp_verified_at).toBeNull();
      expect(ev.otp_attempts).toBe(0);
    });

    it('sin SECRETS_KEY el servicio no firma: 503 y la solicitud sigue pendiente', async () => {
      const s = await conSesion('Sin otp', noKeyApp);
      const r = await enviar(s, { photo: null });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('STORAGE_NOT_CONFIGURED');
      expect((await pool.query('SELECT status FROM signature_requests WHERE id=$1', [s.id])).rows[0].status).toBe('PENDING');
      expect((await pool.query('SELECT 1 FROM signature_evidence WHERE request_id=$1', [s.id])).rowCount).toBe(0);
    });
  });

  describe('descargas para el host (clave de API)', () => {
    it('el host obtiene el PDF y la foto de SU solicitud firmada', async () => {
      const f = await firmar();
      const pdf = await http().get(`/v1/requests/${f.id}/document`).set('X-Api-Key', tenants['Firma'].key);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(sha(Buffer.from(pdf.body))).toBe(f.res.body.pdfSha256);
      expect(pdf.headers['x-content-type-options']).toBe('nosniff');

      const foto = await http().get(`/v1/requests/${f.id}/photo`).set('X-Api-Key', tenants['Firma'].key);
      expect(foto.status).toBe(200);
      expect(foto.headers['content-type']).toBe('image/png');
      expect(Buffer.from(foto.body).equals(FOTO)).toBe(true);
    });

    it('otro tenant no puede descargar nada de esa solicitud (404, igual que una inexistente)', async () => {
      const f = await firmar();
      for (const kind of ['document', 'photo']) {
        const r = await http().get(`/v1/requests/${f.id}/${kind}`).set('X-Api-Key', tenants['Otro'].key);
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('REQUEST_NOT_FOUND');
      }
    });

    it('sin clave de API: 401', async () => {
      const f = await firmar();
      expect((await http().get(`/v1/requests/${f.id}/document`)).status).toBe(401);
      expect((await http().get(`/v1/requests/${f.id}/photo`)).status).toBe(401);
    });

    it('sin firmar: el documento da 409; sin foto: 404', async () => {
      const s = await conSesion();
      const sinFirmar = await http().get(`/v1/requests/${s.id}/document`).set('X-Api-Key', tenants['Firma'].key);
      expect(sinFirmar.status).toBe(409);
      expect(sinFirmar.body.code).toBe('NOT_SIGNED');

      const sf = await conSesion('Sin foto');
      await enviar(sf, { photo: null }).expect(200);
      const r = await http().get(`/v1/requests/${sf.id}/photo`).set('X-Api-Key', tenants['Sin foto'].key);
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('PHOTO_NOT_FOUND');
    });

    it('la lista muestra la solicitud como firmada, con su fecha y sin link', async () => {
      const f = await firmar();
      const r = await http().get(`/v1/requests/${f.id}`).set('X-Api-Key', tenants['Firma'].key);
      expect(r.body.status).toBe('SIGNED');
      expect(r.body.signedAt).not.toBeNull();
      expect(r.body.signUrl).toBeUndefined();
    });

    it('un id mal formado da 404, no un error de la base', async () => {
      expect((await http().get('/v1/requests/no-es-uuid/document').set('X-Api-Key', tenants['Firma'].key)).status).toBe(404);
    });
  });
});
