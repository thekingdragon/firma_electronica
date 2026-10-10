/**
 * Pruebas de integración de lo operativo: webhooks, revocar, vencimiento, evidencia, revisión humana y
 * retención de fotos. Requieren TEST_DATABASE_URL (base que termine en _test).
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { makePng } from '../documents/image-fixtures';
import { StorageService } from '../storage/storage.service';
import { makeApp, resetDatabase, rewritePast, testDatabaseUrl } from '../test-utils';
import { createTenant, setTenantWebhook } from '../tenants/tenants.service';
import { verifyWebhook } from '../webhooks/signing';
import { BACKOFF_SECONDS, MAX_ATTEMPTS, WebhookWorker } from '../webhooks/webhook.worker';
import { MaintenanceService } from './maintenance.service';

const URL_DB = testDatabaseUrl();
const SECRETS_KEY = randomBytes(32);
const FOTO = makePng(1280, 720);
const FORM = { powers: ['RENOVACIONES'], observation: '', consents: ['DATOS_PERSONALES'] };

interface Hit {
  headers: IncomingHttpHeaders;
  body: string;
  url: string;
}

/** Receptor de webhooks de prueba: guarda lo que llega y responde lo que se le diga. */
async function startReceiver() {
  const hits: Hit[] = [];
  let reply: (req: IncomingMessage, res: ServerResponse) => void = (_r, res) => res.writeHead(200).end('ok');
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), url: req.url ?? '' });
      reply(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    base: `http://127.0.0.1:${port}`,
    hits,
    respond: (fn: typeof reply) => {
      reply = fn;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
type Receiver = Awaited<ReturnType<typeof startReceiver>>;

describe('operación: webhooks, revocar, vencimiento, revisión y retención', () => {
  let app: INestApplication;
  let app2: INestApplication;
  let strictApp: INestApplication;
  let pool: Pool;
  let rx: Receiver;
  let storageDir: string;
  let storage: StorageService;
  let worker: WebhookWorker;
  let maintenance: MaintenanceService;

  const T: Record<string, { key: string; id: string; secret: string | null }> = {};
  const http = (a = app) => request(a.getHttpServer());

  async function mkTenant(name: string, webhookUrl?: string, withSecret = true) {
    const t = await createTenant(pool, { name, country: 'PE', legalName: `${name} SAC`, webhookUrl }, withSecret ? SECRETS_KEY : null);
    T[name] = { key: t.apiKey, id: t.tenant.id, secret: t.webhookSecret };
    // Por defecto estos tenants no exigen OTP ni foto: el flujo de firma se reduce a lo que se prueba.
    await pool.query(`UPDATE document_templates SET otp_required=false, photo_required=false, photo_challenge_required=false, id_photo_required=false, id_photo_back_required=false WHERE tenant_id=$1`, [t.tenant.id]);
    return t.tenant.id;
  }

  const baseBody = (extra: Record<string, unknown> = {}) => ({
    documentType: 'APPOINTMENT_LETTER',
    externalRef: 'ext-1',
    signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
    data: { insurances: ['SCTR Salud'] },
    delivery: { mode: 'HOST' },
    ...extra,
  });

  async function crear(tenant: string, extra: Record<string, unknown> = {}, a = app) {
    const r = await http(a).post('/v1/requests').set('X-Api-Key', T[tenant].key).send(baseBody(extra));
    expect(r.status).toBe(201);
    return { id: r.body.id as string, token: (r.body.signUrl as string).split('/s/')[1], reference: r.body.reference as string };
  }

  /** Abre la sesión (sin OTP) y firma. Con `conFoto` pide el desafío y manda una foto. */
  async function firmar(s: { token: string }, conFoto = false, a = app) {
    const v = await http(a).post(`/v1/sign/${s.token}/verify`).send({}).expect(200);
    const session = v.body.sessionToken as string;
    // El desafío se pide ANTES de armar el envío: supertest cierra el servidor compartido al terminar
    // una petición, y una segunda ya construida se quedaría sin dirección.
    const challengeId = conFoto
      ? ((await http(a).post(`/v1/sign/${s.token}/photo-challenge`).set('X-Session', session).expect(200)).body.challengeId as string)
      : null;
    const req = http(a).post(`/v1/sign/${s.token}/submit`).set('X-Session', session).field('accepted', 'true').field('form', JSON.stringify(FORM));
    if (challengeId) req.field('challengeId', challengeId).attach('photo', FOTO, { filename: 'f.png', contentType: 'image/png' }).attach('idPhoto', FOTO, { filename: 'd.png', contentType: 'image/png' }).attach('idPhotoBack', FOTO, { filename: 'r.png', contentType: 'image/png' });
    return req;
  }


  /** Firma y exige 200; devuelve la respuesta. */
  async function firmarOk(s: { token: string }, conFoto = false, a = app) {
    const r = await firmar(s, conFoto, a);
    expect(r.status).toBe(200);
    return r;
  }

  const deliveries = async (id: string) =>
    (await pool.query('SELECT * FROM webhook_deliveries WHERE request_id=$1 ORDER BY created_at', [id])).rows;
  const due = (id: string) => pool.query('UPDATE webhook_deliveries SET next_try_at = now() WHERE request_id=$1 AND delivered_at IS NULL AND failed_at IS NULL', [id]);

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    storageDir = await mkdtemp(join(tmpdir(), 'fes-ops-'));
    rx = await startReceiver();

    await mkTenant('Hook', rx.url);
    await mkTenant('SinUrl');
    await mkTenant('SinSecreto', rx.url, false);
    await mkTenant('Otro');
    const fotoId = await mkTenant('ConFoto');
    await pool.query(`UPDATE document_templates SET photo_required=true, photo_challenge_required=true WHERE tenant_id=$1`, [fotoId]);
    const retId = await mkTenant('Retencion');
    await pool.query(`UPDATE document_templates SET photo_required=true, photo_challenge_required=true WHERE tenant_id=$1`, [retId]);
    await pool.query(`UPDATE tenants SET retention_days = 1 WHERE id=$1`, [retId]);

    const env = {
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      SECRETS_KEY: SECRETS_KEY.toString('base64'),
      STORAGE_DIR: storageDir,
    };
    app = await makeApp({ ...env, WEBHOOK_ALLOW_PRIVATE: 'true' });
    app2 = await makeApp({ ...env, WEBHOOK_ALLOW_PRIVATE: 'true' });
    strictApp = await makeApp({ ...env, WEBHOOK_ALLOW_PRIVATE: 'false' });
    worker = app.get(WebhookWorker, { strict: false });
    maintenance = app.get(MaintenanceService, { strict: false });
    storage = new StorageService({ storageDir, secretsKey: SECRETS_KEY } as never);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await app2?.close();
    await strictApp?.close();
    await pool?.end();
    await rx?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    rx.hits.length = 0;
    rx.respond((_r, res) => res.writeHead(200).end('ok'));
  });

  // -------------------------------------------------------------------------------------------
  describe('webhook: encolar (outbox)', () => {
    it('firmar registra UN evento con el cuerpo congelado, en la misma transacción', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      const d = await deliveries(s.id);
      expect(d).toHaveLength(1);
      expect(d[0].event).toBe('signature.signed');
      expect(d[0].url).toBe(rx.url);
      expect(d[0].payload.event).toBe('signature.signed');
      expect(d[0].payload.id).toBe(d[0].id);
      expect(d[0].payload.data).toMatchObject({
        requestId: s.id,
        reference: s.reference,
        externalRef: 'ext-1',
        status: 'SIGNED',
        documentPath: `/v1/requests/${s.id}/document`,
        photoPath: null,
        review: null,
      });
      expect(d[0].payload.data.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('una firma rechazada NO deja ningún evento', async () => {
      const s = await crear('Hook');
      const v = await http().post(`/v1/sign/${s.token}/verify`).send({}).expect(200);
      await http()
        .post(`/v1/sign/${s.token}/submit`)
        .set('X-Session', v.body.sessionToken)
        .field('accepted', 'true')
        .field('form', JSON.stringify({ powers: [], observation: '' }))
        .expect(422);
      expect(await deliveries(s.id)).toHaveLength(0);
    });

    it('sin URL en la solicitud ni en el tenant no se encola nada', async () => {
      const s = await crear('SinUrl');
      await firmarOk(s);
      expect(await deliveries(s.id)).toHaveLength(0);
    });

    it('la URL de la solicitud manda sobre la del tenant', async () => {
      const otro = await startReceiver();
      try {
        const s = await crear('Hook', { webhookUrl: otro.url });
        await firmarOk(s);
        expect((await deliveries(s.id))[0].url).toBe(otro.url);
      } finally {
        await otro.close();
      }
    });

    it('cambiar la URL del tenant después de encolar no desvía un evento ya registrado', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      await pool.query(`UPDATE tenants SET webhook_url = 'http://127.0.0.1:1/otro' WHERE id=$1`, [T['Hook'].id]);
      try {
        expect((await deliveries(s.id))[0].url).toBe(rx.url);
        await worker.runOnce();
        expect(rx.hits.filter((h) => h.body.includes(s.id))).toHaveLength(1);
      } finally {
        await pool.query(`UPDATE tenants SET webhook_url = $2 WHERE id=$1`, [T['Hook'].id, rx.url]);
      }
    });

    it('el secreto del webhook está cifrado en la base', async () => {
      const { rows } = await pool.query('SELECT webhook_secret_enc FROM tenants WHERE id=$1', [T['Hook'].id]);
      expect(rows[0].webhook_secret_enc).toMatch(/^v1:/);
      expect(rows[0].webhook_secret_enc).not.toContain(T['Hook'].secret as string);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('webhook: entregar', () => {
    it('entrega con firma HMAC válida, cabeceras y el cuerpo exacto', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      expect(await worker.runOnce()).toBeGreaterThanOrEqual(1);

      const hit = rx.hits.find((h) => h.body.includes(s.id));
      expect(hit).toBeDefined();
      if (!hit) return;
      const d = (await deliveries(s.id))[0];
      expect(hit.headers['x-webhook-id']).toBe(d.id);
      expect(hit.headers['x-webhook-event']).toBe('signature.signed');
      expect(hit.headers['content-type']).toBe('application/json');
      expect(JSON.parse(hit.body)).toEqual(d.payload);
      // Lo que debe hacer el host: verificar con SU secreto.
      expect(verifyWebhook(T['Hook'].secret as string, hit.headers['x-signature'] as string, hit.body)).toBe(true);
      expect(verifyWebhook('otro-secreto-' + 'z'.repeat(40), hit.headers['x-signature'] as string, hit.body)).toBe(false);

      const after = (await deliveries(s.id))[0];
      expect(after.delivered_at).not.toBeNull();
      expect(after.attempts).toBe(1);
      expect(after.last_status).toBe(200);
      expect(after.last_error).toBeNull();
    });

    it('lo entregado no se vuelve a entregar', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      await worker.runOnce();
      const n = rx.hits.filter((h) => h.body.includes(s.id)).length;
      await worker.runOnce();
      await worker.runOnce();
      expect(rx.hits.filter((h) => h.body.includes(s.id)).length).toBe(n);
    });

    it('un 500 se reintenta con espera creciente (no antes de tiempo) y luego entrega', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      rx.respond((_r, res) => res.writeHead(500).end('boom'));
      await worker.runOnce();

      const d1 = (await deliveries(s.id))[0];
      expect(d1.attempts).toBe(1);
      expect(d1.delivered_at).toBeNull();
      expect(d1.failed_at).toBeNull();
      expect(d1.last_status).toBe(500);
      expect(d1.last_error).toContain('500');
      const wait = Number((await pool.query(`SELECT extract(epoch FROM next_try_at - now()) AS w FROM webhook_deliveries WHERE id=$1`, [d1.id])).rows[0].w);
      expect(wait).toBeGreaterThan(BACKOFF_SECONDS[0] - 5);
      expect(wait).toBeLessThanOrEqual(BACKOFF_SECONDS[0]);

      // Todavía no toca: otro ciclo no lo reintenta.
      const antes = rx.hits.length;
      await worker.runOnce();
      expect(rx.hits.length).toBe(antes);

      // Llega la hora y el receptor ya funciona.
      rx.respond((_r, res) => res.writeHead(200).end('ok'));
      await due(s.id);
      await worker.runOnce();
      const d2 = (await deliveries(s.id))[0];
      expect(d2.delivered_at).not.toBeNull();
      expect(d2.attempts).toBe(2);
      expect(d2.last_error).toBeNull();
    });

    it('la espera sigue el calendario completo y tras el último intento se da por fallido', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      rx.respond((_r, res) => res.writeHead(503).end());
      for (let intento = 1; intento <= MAX_ATTEMPTS; intento++) {
        await due(s.id);
        await worker.runOnce();
        const d = (await deliveries(s.id))[0];
        expect(d.attempts).toBe(intento);
        if (intento < MAX_ATTEMPTS) {
          expect(d.failed_at).toBeNull();
          const w = Number((await pool.query(`SELECT extract(epoch FROM next_try_at - now()) AS w FROM webhook_deliveries WHERE id=$1`, [d.id])).rows[0].w);
          expect(w).toBeLessThanOrEqual(BACKOFF_SECONDS[intento - 1]);
          expect(w).toBeGreaterThan(BACKOFF_SECONDS[intento - 1] - 5);
        } else {
          expect(d.failed_at).not.toBeNull();
        }
      }
      const hits = rx.hits.filter((h) => h.body.includes(s.id)).length;
      expect(hits).toBe(MAX_ATTEMPTS);
      // Fallido: ya no se intenta más, aunque se fuerce la hora.
      await pool.query(`UPDATE webhook_deliveries SET next_try_at = now() WHERE request_id=$1`, [s.id]);
      await worker.runOnce();
      expect(rx.hits.filter((h) => h.body.includes(s.id)).length).toBe(hits);
    });

    it('un destino que no existe (conexión rechazada) se reintenta, no se pierde', async () => {
      const muerto = await startReceiver();
      const url = muerto.url;
      await muerto.close();
      const s = await crear('Hook', { webhookUrl: url });
      await firmarOk(s);
      await worker.runOnce();
      const d = (await deliveries(s.id))[0];
      expect(d.attempts).toBe(1);
      expect(d.delivered_at).toBeNull();
      expect(d.failed_at).toBeNull();
      expect(d.last_error).toBeTruthy();
      expect(d.last_status).toBeNull();
    });

    it('una redirección NO se sigue (podría llevar a una dirección interna)', async () => {
      const secreto = await startReceiver();
      try {
        rx.respond((_r, res) => res.writeHead(302, { Location: `${secreto.base}/interno` }).end());
        const s = await crear('Hook');
        await firmarOk(s);
        await worker.runOnce();
        const d = (await deliveries(s.id))[0];
        expect(d.last_status).toBe(302);
        expect(d.last_error).toContain('redirección');
        expect(d.delivered_at).toBeNull();
        expect(secreto.hits).toHaveLength(0);
      } finally {
        await secreto.close();
      }
    });

    it('sin secreto configurado el evento no se pierde: queda reintentando con un motivo claro', async () => {
      const s = await crear('SinSecreto');
      await firmarOk(s);
      await worker.runOnce();
      const d = (await deliveries(s.id))[0];
      expect(d.last_error).toContain('secreto');
      expect(d.delivered_at).toBeNull();
      expect(d.failed_at).toBeNull();
      expect(rx.hits.filter((h) => h.body.includes(s.id))).toHaveLength(0);
    });

    it('rotar el secreto: lo nuevo se firma con el secreto nuevo y el viejo deja de verificar', async () => {
      const viejo = T['Hook'].secret as string;
      const { secret } = await setTenantWebhook(pool, SECRETS_KEY, T['Hook'].id, { rotateSecret: true });
      expect(secret).toMatch(/^whsec_/);
      expect(secret).not.toBe(viejo);
      T['Hook'].secret = secret;
      const s = await crear('Hook');
      await firmarOk(s);
      await worker.runOnce();
      const hit = rx.hits.find((h) => h.body.includes(s.id));
      expect(hit).toBeDefined();
      if (!hit) return;
      expect(verifyWebhook(secret as string, hit.headers['x-signature'] as string, hit.body)).toBe(true);
      expect(verifyWebhook(viejo, hit.headers['x-signature'] as string, hit.body)).toBe(false);
    });

    it('una segunda instancia que llega MIENTRAS la primera todavía entrega no repite el envío', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      // El receptor tarda: la primera instancia sigue «en vuelo» cuando llega la segunda.
      rx.respond((_r, res) => setTimeout(() => res.writeHead(200).end('ok'), 400));
      const w2 = app2.get(WebhookWorker, { strict: false });
      const primera = worker.runOnce();
      await new Promise((r) => setTimeout(r, 120));
      const segunda = w2.runOnce();
      await Promise.all([primera, segunda]);
      expect(rx.hits.filter((h) => h.body.includes(s.id))).toHaveLength(1);
      expect((await deliveries(s.id))[0].attempts).toBe(1);
    });

    it('dos instancias del servicio a la vez NO entregan lo mismo dos veces', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      const w2 = app2.get(WebhookWorker, { strict: false });
      await Promise.all([worker.runOnce(), w2.runOnce()]);
      expect(rx.hits.filter((h) => h.body.includes(s.id))).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('webhook: protección contra SSRF', () => {
    it('una URL a una dirección privada NO se contacta (el receptor ni se entera) y queda registrada la razón', async () => {
      const s = await crear('Hook', { webhookUrl: rx.url }, strictApp); // rx.url es http://127.0.0.1
      await firmarOk(s, false, strictApp);
      const w = strictApp.get(WebhookWorker, { strict: false });
      await w.runOnce();
      expect(rx.hits.filter((h) => h.body.includes(s.id))).toHaveLength(0);
      const d = (await deliveries(s.id))[0];
      expect(d.last_error).toContain('no pública');
      expect(d.delivered_at).toBeNull();
    });

    it('un nombre que resuelve a localhost tampoco (la dirección se valida al conectar)', async () => {
      const port = new URL(rx.url).port;
      const s = await crear('Hook', { webhookUrl: `http://localhost:${port}/hook` }, strictApp);
      await firmarOk(s, false, strictApp);
      await strictApp.get(WebhookWorker, { strict: false }).runOnce();
      expect(rx.hits.filter((h) => h.body.includes(s.id))).toHaveLength(0);
      expect((await deliveries(s.id))[0].last_error).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('revocar', () => {
    it('revoca una pendiente: el link deja de abrir, queda en la bitácora y se avisa al host', async () => {
      const s = await crear('Hook');
      const r = await http().post(`/v1/requests/${s.id}/revoke`).set('X-Api-Key', T['Hook'].key);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ id: s.id, status: 'REVOKED' });

      const intro = await http().get(`/v1/sign/${s.token}`);
      expect(intro.status).toBe(410);
      expect(intro.body.code).toBe('LINK_REVOKED');
      expect((await pool.query(`SELECT status FROM signature_requests WHERE id=$1`, [s.id])).rows[0].status).toBe('REVOKED');
      expect((await pool.query(`SELECT 1 FROM access_log WHERE request_id=$1 AND event='revoked'`, [s.id])).rowCount).toBe(1);
      const d = await deliveries(s.id);
      expect(d.map((x) => x.event)).toEqual(['signature.revoked']);
      expect(d[0].payload.data.status).toBe('REVOKED');
    });

    it('con una sesión ya abierta, revocar corta la posibilidad de firmar', async () => {
      const s = await crear('Hook');
      const v = await http().post(`/v1/sign/${s.token}/verify`).send({}).expect(200);
      await http().post(`/v1/requests/${s.id}/revoke`).set('X-Api-Key', T['Hook'].key).expect(200);
      const r = await http()
        .post(`/v1/sign/${s.token}/submit`)
        .set('X-Session', v.body.sessionToken)
        .field('accepted', 'true')
        .field('form', JSON.stringify(FORM));
      expect(r.status).toBe(410);
      expect(r.body.code).toBe('LINK_REVOKED');
    });

    it('no se puede revocar lo firmado, lo vencido ni lo ya revocado (409 con el estado)', async () => {
      const firmada = await crear('Hook');
      await firmarOk(firmada);
      const a = await http().post(`/v1/requests/${firmada.id}/revoke`).set('X-Api-Key', T['Hook'].key);
      expect(a.status).toBe(409);
      expect(a.body.code).toBe('NOT_PENDING');
      expect(a.body.status).toBe('SIGNED');

      const pendiente = await crear('Hook');
      await http().post(`/v1/requests/${pendiente.id}/revoke`).set('X-Api-Key', T['Hook'].key).expect(200);
      const b = await http().post(`/v1/requests/${pendiente.id}/revoke`).set('X-Api-Key', T['Hook'].key);
      expect(b.status).toBe(409);
      expect(b.body.status).toBe('REVOKED');
      // Y no se duplicó el aviso.
      expect((await deliveries(pendiente.id)).filter((x) => x.event === 'signature.revoked')).toHaveLength(1);
    });

    it('otro tenant, un id inexistente o mal formado: 404; sin clave: 401', async () => {
      const s = await crear('Hook');
      expect((await http().post(`/v1/requests/${s.id}/revoke`).set('X-Api-Key', T['Otro'].key)).status).toBe(404);
      expect((await http().post('/v1/requests/00000000-0000-4000-8000-000000000000/revoke').set('X-Api-Key', T['Hook'].key)).status).toBe(404);
      expect((await http().post('/v1/requests/no-es-uuid/revoke').set('X-Api-Key', T['Hook'].key)).status).toBe(404);
      expect((await http().post(`/v1/requests/${s.id}/revoke`)).status).toBe(401);
      // Y la solicitud sigue pendiente: ninguno de esos intentos la tocó.
      expect((await pool.query(`SELECT status FROM signature_requests WHERE id=$1`, [s.id])).rows[0].status).toBe('PENDING');
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('vencimiento automático', () => {
    it('marca como vencidas solo las pendientes pasadas de fecha, y avisa al host', async () => {
      const vencida = await crear('Hook');
      const vigente = await crear('Hook');
      const firmada = await crear('Hook');
      await firmarOk(firmada);
      await rewritePast(pool, `UPDATE signature_requests SET expires_at = now() - interval '1 minute' WHERE id = ANY($1)`, [[vencida.id, firmada.id]]);

      const n = await maintenance.expireOverdue();
      expect(n).toBeGreaterThanOrEqual(1);
      const st = async (id: string) => (await pool.query(`SELECT status FROM signature_requests WHERE id=$1`, [id])).rows[0].status;
      expect(await st(vencida.id)).toBe('EXPIRED');
      expect(await st(vigente.id)).toBe('PENDING');
      expect(await st(firmada.id)).toBe('SIGNED'); // lo firmado no se «vence» aunque pase la fecha
      expect((await deliveries(vencida.id)).map((d) => d.event)).toEqual(['signature.expired']);
      expect((await deliveries(vigente.id))).toHaveLength(0);
      expect((await pool.query(`SELECT 1 FROM access_log WHERE request_id=$1 AND event='expired'`, [vencida.id])).rowCount).toBe(1);
    });

    it('es idempotente y dos corridas simultáneas no duplican avisos', async () => {
      const s = await crear('Hook');
      await pool.query(`UPDATE signature_requests SET expires_at = now() - interval '1 minute' WHERE id=$1`, [s.id]);
      const [a, b] = await Promise.all([maintenance.expireOverdue(), app2.get(MaintenanceService, { strict: false }).expireOverdue()]);
      expect(a + b).toBeGreaterThanOrEqual(1);
      expect((await deliveries(s.id)).filter((d) => d.event === 'signature.expired')).toHaveLength(1);
      expect(await maintenance.expireOverdue()).toBe(0);
    });

    it('una solicitud vencida ya no abre y no se puede revocar', async () => {
      const s = await crear('Hook');
      await pool.query(`UPDATE signature_requests SET expires_at = now() - interval '1 minute' WHERE id=$1`, [s.id]);
      await maintenance.expireOverdue();
      expect((await http().get(`/v1/sign/${s.token}`)).body.code).toBe('LINK_EXPIRED');
      const r = await http().post(`/v1/requests/${s.id}/revoke`).set('X-Api-Key', T['Hook'].key);
      expect(r.status).toBe(409);
      expect(r.body.status).toBe('EXPIRED');
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('evidencia y revisión humana', () => {
    it('la evidencia reúne todo lo registrado de una firma con foto', async () => {
      const s = await crear('ConFoto');
      await firmarOk(s, true);
      const r = await http().get(`/v1/requests/${s.id}/evidence`).set('X-Api-Key', T['ConFoto'].key);
      expect(r.status).toBe(200);
      expect(r.body.reference).toBe(s.reference);
      expect(r.body.status).toBe('SIGNED');
      expect(r.body.signer.name).toBe('Ana Pérez');
      expect(r.body.photo).toMatchObject({ width: 1280, height: 720, deletedAt: null });
      expect(r.body.photo.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.body.challenge.code).toMatch(/^\d{4}$/);
      expect(r.body.form).toEqual(FORM);
      expect(r.body.otp).toBeNull(); // este tipo no exige OTP
      expect(r.body.ip).toMatch(/^127\.0\.0\.1/);
      expect(r.body.review).toBeNull();
      expect(r.body.events.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(['session_opened', 'photo_challenge_issued', 'signed']));
    });

    it('sin firmar: 409; de otro tenant o inexistente: 404; sin clave: 401', async () => {
      const s = await crear('ConFoto');
      expect((await http().get(`/v1/requests/${s.id}/evidence`).set('X-Api-Key', T['ConFoto'].key)).status).toBe(409);
      expect((await http().get(`/v1/requests/${s.id}/evidence`).set('X-Api-Key', T['Otro'].key)).status).toBe(404);
      expect((await http().get('/v1/requests/no-es-uuid/evidence').set('X-Api-Key', T['ConFoto'].key)).status).toBe(404);
      expect((await http().get(`/v1/requests/${s.id}/evidence`)).status).toBe(401);
    });

    it('la revisión se guarda, se ve en la lista, entra en la bitácora y avisa al host', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      const r = await http()
        .post(`/v1/requests/${s.id}/review`)
        .set('X-Api-Key', T['Hook'].key)
        .send({ result: 'VERIFIED', reviewedBy: 'María López', note: 'El rostro coincide con el DNI.' });
      expect(r.status).toBe(200);
      expect(r.body.result).toBe('VERIFIED');

      const ev = (await http().get(`/v1/requests/${s.id}/evidence`).set('X-Api-Key', T['Hook'].key)).body;
      expect(ev.review).toMatchObject({ result: 'VERIFIED', reviewedBy: 'María López', note: 'El rostro coincide con el DNI.' });
      const lista = await http().get('/v1/requests').set('X-Api-Key', T['Hook'].key);
      expect(lista.body.items.find((i: { id: string }) => i.id === s.id).review).toBe('VERIFIED');
      expect((await http().get(`/v1/requests/${s.id}`).set('X-Api-Key', T['Hook'].key)).body.review).toBe('VERIFIED');

      const d = (await deliveries(s.id)).find((x) => x.event === 'signature.reviewed');
      expect(d.payload.data.review).toMatchObject({ result: 'VERIFIED', reviewedBy: 'María López' });
      expect((await pool.query(`SELECT detail FROM access_log WHERE request_id=$1 AND event='reviewed'`, [s.id])).rows).toHaveLength(1);
    });

    it('se puede corregir un dictamen: queda el nuevo y la bitácora conserva el anterior', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      const call = (result: string) =>
        http().post(`/v1/requests/${s.id}/review`).set('X-Api-Key', T['Hook'].key).send({ result, reviewedBy: 'Juan Quispe' });
      await call('VERIFIED').expect(200);
      await call('REJECTED').expect(200);
      expect((await pool.query('SELECT review_result FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0].review_result).toBe('REJECTED');
      const log = (await pool.query(`SELECT detail FROM access_log WHERE request_id=$1 AND event='reviewed' ORDER BY id`, [s.id])).rows;
      expect(log.map((l) => l.detail.previous)).toEqual([null, 'VERIFIED']);
      expect((await deliveries(s.id)).filter((x) => x.event === 'signature.reviewed')).toHaveLength(2);
    });

    it('validaciones: resultado inválido, revisor ausente, campo extra, nota enorme, UTF-8 roto', async () => {
      const s = await crear('Hook');
      await firmarOk(s);
      const call = (b: unknown) => http().post(`/v1/requests/${s.id}/review`).set('X-Api-Key', T['Hook'].key).send(b as object);
      expect((await call({ result: 'TAL_VEZ', reviewedBy: 'Ana' })).status).toBe(422);
      expect((await call({ result: 'VERIFIED' })).status).toBe(422);
      expect((await call({ result: 'VERIFIED', reviewedBy: 'x' })).status).toBe(422);
      expect((await call({ result: 'VERIFIED', reviewedBy: 'Ana Ruiz', extra: 1 })).status).toBe(422);
      expect((await call({ result: 'VERIFIED', reviewedBy: 'Ana Ruiz', note: 'n'.repeat(501) })).status).toBe(422);
      const roto = await http()
        .post(`/v1/requests/${s.id}/review`)
        .set('X-Api-Key', T['Hook'].key)
        .set('Content-Type', 'application/json')
        .serialize(() => Buffer.from('{"result":"VERIFIED","reviewedBy":"Mar\xeda L\xf3pez"}', 'latin1') as unknown as string)
        .send({});
      expect(roto.status).toBe(422);
      expect(roto.body.code).toBe('INVALID_ENCODING');
      // Ninguno dejó un dictamen a medias.
      expect((await pool.query('SELECT review_result FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0].review_result).toBeNull();
    });

    it('solo se revisa lo firmado; otro tenant no puede revisar; sin clave 401', async () => {
      const pendiente = await crear('Hook');
      const body = { result: 'VERIFIED', reviewedBy: 'Ana Ruiz' };
      expect((await http().post(`/v1/requests/${pendiente.id}/review`).set('X-Api-Key', T['Hook'].key).send(body)).status).toBe(409);
      const firmada = await crear('Hook');
      await firmarOk(firmada);
      expect((await http().post(`/v1/requests/${firmada.id}/review`).set('X-Api-Key', T['Otro'].key).send(body)).status).toBe(404);
      expect((await http().post(`/v1/requests/${firmada.id}/review`).send(body)).status).toBe(401);
      expect((await pool.query('SELECT review_result FROM signature_evidence WHERE request_id=$1', [firmada.id])).rows[0].review_result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('retención de fotos', () => {
    const existe = (p: string) =>
      access(join(storageDir, p)).then(
        () => true,
        () => false,
      );

    it('al vencer el plazo borra el ARCHIVO de la foto y conserva la constancia, el PDF y los hashes', async () => {
      const s = await crear('Retencion');
      const res = await firmarOk(s, true);
      const antes = (await pool.query('SELECT photo_path, photo_sha256 FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0];
      expect(await existe(antes.photo_path)).toBe(true);
      const pdfAntes = await http().get(`/v1/requests/${s.id}/document`).set('X-Api-Key', T['Retencion'].key);

      await rewritePast(pool, `UPDATE signature_requests SET signed_at = now() - interval '2 days' WHERE id=$1`, [s.id]);
      expect(await maintenance.purgeExpiredPhotos()).toBeGreaterThanOrEqual(1);

      expect(await existe(antes.photo_path)).toBe(false);
      const despues = (await pool.query('SELECT photo_path, photo_deleted_at, photo_sha256 FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0];
      expect(despues.photo_path).toBeNull();
      expect(despues.photo_deleted_at).not.toBeNull();
      expect(despues.photo_sha256).toBe(antes.photo_sha256); // el hash se conserva

      const foto = await http().get(`/v1/requests/${s.id}/photo`).set('X-Api-Key', T['Retencion'].key);
      expect(foto.status).toBe(410);
      expect(foto.body.code).toBe('PHOTO_PURGED');
      const ev = (await http().get(`/v1/requests/${s.id}/evidence`).set('X-Api-Key', T['Retencion'].key)).body;
      expect(ev.photo.deletedAt).not.toBeNull();
      expect(ev.photo.sha256).toBe(antes.photo_sha256);

      // El PDF firmado NO se toca: sigue íntegro y con el mismo hash.
      const pdfDespues = await http().get(`/v1/requests/${s.id}/document`).set('X-Api-Key', T['Retencion'].key);
      expect(pdfDespues.status).toBe(200);
      expect(Buffer.from(pdfDespues.body).equals(Buffer.from(pdfAntes.body))).toBe(true);
      expect(res.body.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await pool.query(`SELECT 1 FROM access_log WHERE request_id=$1 AND event='photo_purged'`, [s.id])).rowCount).toBe(1);
    });

    it('lo que todavía está dentro del plazo no se toca, y repetir la tarea no hace nada', async () => {
      const s = await crear('Retencion');
      await firmarOk(s, true);
      const path = (await pool.query('SELECT photo_path FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0].photo_path;
      await maintenance.purgeExpiredPhotos();
      expect(await existe(path)).toBe(true);
      expect((await pool.query('SELECT photo_deleted_at FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0].photo_deleted_at).toBeNull();
      expect((await http().get(`/v1/requests/${s.id}/photo`).set('X-Api-Key', T['Retencion'].key)).status).toBe(200);

      await rewritePast(pool, `UPDATE signature_requests SET signed_at = now() - interval '2 days' WHERE id=$1`, [s.id]);
      await maintenance.purgeExpiredPhotos();
      expect(await maintenance.purgeExpiredPhotos()).toBe(0);
    });

    it('el plazo es por tenant: otro con más retención conserva su foto', async () => {
      const s = await crear('ConFoto'); // retention_days por defecto: 1825
      await firmarOk(s, true);
      await rewritePast(pool, `UPDATE signature_requests SET signed_at = now() - interval '30 days' WHERE id=$1`, [s.id]);
      await maintenance.purgeExpiredPhotos();
      expect((await http().get(`/v1/requests/${s.id}/photo`).set('X-Api-Key', T['ConFoto'].key)).status).toBe(200);
    });

    it('si el archivo ya no estaba en disco, igual se registra el borrado (no se queda trabado)', async () => {
      const s = await crear('Retencion');
      await firmarOk(s, true);
      const path = (await pool.query('SELECT photo_path FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0].photo_path;
      await storage.remove(path);
      await rewritePast(pool, `UPDATE signature_requests SET signed_at = now() - interval '2 days' WHERE id=$1`, [s.id]);
      await maintenance.purgeExpiredPhotos();
      expect((await pool.query('SELECT photo_deleted_at FROM signature_evidence WHERE request_id=$1', [s.id])).rows[0].photo_deleted_at).not.toBeNull();
    });
  });
});
