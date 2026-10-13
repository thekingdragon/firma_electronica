/**
 * «Atendido por»: la persona que creó la solicitud y envió el enlace (NO quien revisa) queda guardada, sale en el pie de
 * página del PDF firmado y en la vista del firmante, y no se puede falsear. Requiere TEST_DATABASE_URL.
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
import { makeApp, pdfPagesText, resetDatabase, testDatabaseUrl } from '../test-utils';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');
const PASS = 'Contrasena-Segura-123';
const BLOCKS = [
  { id: 'p', type: 'paragraph', text: 'Yo, **{{signer.name}}**, acepto.' },
  { id: 's', type: 'signatureStamp' },
];
const PIE = 'Cliente: **{{signer.name}}** · {{signer.documentType}} {{signer.documentNumber}} · {{date}} · Atendido por: **{{attendedBy}}**';

describe('atendido por (quien envió el enlace)', () => {
  let app: INestApplication;
  let pool: Pool;
  let storage: StorageService;
  let storageDir: string;
  let keyA: string;
  let tenantA: string;
  let ana: string;
  let revisor: string;

  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    documentType: 'APPOINTMENT_LETTER',
    externalRef: `r-${randomBytes(4).toString('hex')}`,
    signer: { name: 'Gustavo Martinez', documentType: 'DNI', documentNumber: '72397064' },
    data: { insurances: ['SCTR'] },
    otp: { channel: 'EMAIL', to: 'g@example.com' },
    delivery: { mode: 'HOST' },
    ...extra,
  });

  async function sesion(role: 'ADMIN' | 'REVIEWER', email: string, name: string) {
    const u = await insertUser(pool, { tenantId: tenantA, email, name, role });
    await pool.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, await hashPassword(PASS)]);
    return (await http().post('/v1/auth/login').send({ email, password: PASS })).body.accessToken as string;
  }
  const atendido = async (id: string) => (await pool.query('SELECT attended_by FROM signature_requests WHERE id = $1', [id])).rows[0].attended_by as string | null;

  async function firmar(id: string, token: string) {
    const otp = await http().post(`/v1/sign/${token}/otp`);
    const v = await http().post(`/v1/sign/${token}/verify`).send({ code: otp.body.devCode });
    const session = v.body.sessionToken as string;
    const vista = await http().get(`/v1/sign/${token}/view`).set('X-Session', session);
    const res = await http().post(`/v1/sign/${token}/submit`).set('X-Session', session).field('accepted', 'true').field('form', JSON.stringify({ powers: [], observation: '', consents: [] }));
    expect(res.status).toBe(200);
    const row = (await pool.query('SELECT pdf_path FROM signature_requests WHERE id = $1', [id])).rows[0];
    return { vista: vista.body, pdf: await storage.get(row.pdf_path) };
  }

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    const a = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A' });
    keyA = a.apiKey;
    tenantA = a.tenant.id;
    await publishTemplate(pool, tenantA, 'APPOINTMENT_LETTER', { blocks: BLOCKS, footer: PIE, clauseText: 'Acepto.', otpRequired: true, photoRequired: false, photoChallengeRequired: false, idPhotoRequired: false, idPhotoBackRequired: false, reviewRequired: false, publishedBy: 'prueba' });
    storageDir = await mkdtemp(join(tmpdir(), 'fes-att-'));
    app = await makeApp({ DATABASE_URL: URL_DB, TOKEN_SECRET: 't'.repeat(40), PUBLIC_BASE_URL: 'https://firma.test', NODE_ENV: 'test', SECRETS_KEY: KEY_B64, STORAGE_DIR: storageDir, ALLOW_DEV_OTP: 'true' });
    storage = app.get(StorageService);
    ana = await sesion('ADMIN', 'ana@a.test', 'Ana Atiende');
    revisor = await sesion('REVIEWER', 'revisor@a.test', 'Rosa Revisora');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('con sesión, queda quien tiene la sesión; lo que mande el cuerpo se IGNORA (no se puede falsear)', async () => {
    const r = await http().post('/v1/requests').set(bearer(ana)).send(cuerpo({ attendedBy: 'Falso Nombre' }));
    expect(r.status).toBe(201);
    expect(await atendido(r.body.id)).toBe('Ana Atiende');
  });

  it('con la clave de API, la integración informa quién atendió; si no lo informa, queda sin dato', async () => {
    const con = await http().post('/v1/requests').set('X-Api-Key', keyA).send(cuerpo({ attendedBy: 'Pedro del sistema contable' }));
    expect(con.status).toBe(201);
    expect(await atendido(con.body.id)).toBe('Pedro del sistema contable');
    const sin = await http().post('/v1/requests').set('X-Api-Key', keyA).send(cuerpo());
    expect(await atendido(sin.body.id)).toBeNull();
    expect((await http().post('/v1/requests').set('X-Api-Key', keyA).send(cuerpo({ attendedBy: '' }))).status).toBe(422);
    expect((await http().post('/v1/requests').set('X-Api-Key', keyA).send(cuerpo({ attendedBy: 'x'.repeat(161) }))).status).toBe(422);
  });

  it('aparece en el listado y en el detalle del panel', async () => {
    const r = await http().post('/v1/requests').set(bearer(ana)).send(cuerpo());
    const detalle = await http().get(`/v1/requests/${r.body.id}`).set(bearer(revisor));
    expect(detalle.body.attendedBy).toBe('Ana Atiende');
    const lista = await http().get('/v1/requests').set(bearer(revisor));
    expect(lista.body.items.find((i: { id: string }) => i.id === r.body.id).attendedBy).toBe('Ana Atiende');
  });

  it('el firmante lo ve en el pie de su vista y sale en el PDF firmado, en la zona de la corredora', async () => {
    const r = await http().post('/v1/requests').set(bearer(ana)).send(cuerpo());
    const { vista, pdf } = await firmar(r.body.id, (r.body.signUrl as string).split('/s/')[1]);
    expect(vista.footer).toContain('Atendido por: **Ana Atiende**');
    expect(vista.footer).toContain('Gustavo Martinez');
    expect(vista.footer).toContain('72397064');
    const texto = (await pdfPagesText(pdf)).join(' ');
    expect(texto).toContain('Atendido por:');
    expect(texto).toContain('Ana Atiende');
    expect(texto).toContain('72397064');
  });

  it('quien REVISA no cambia a quien atendió: la revisión queda a nombre del revisor y el PDF sigue diciendo quién atendió', async () => {
    const r = await http().post('/v1/requests').set(bearer(ana)).send(cuerpo());
    const { pdf } = await firmar(r.body.id, (r.body.signUrl as string).split('/s/')[1]);
    const rev = await http().post(`/v1/requests/${r.body.id}/review`).set(bearer(revisor)).send({ result: 'VERIFIED', reviewedBy: 'x', note: 'ok' });
    expect(rev.status).toBe(200);
    const evid = (await http().get(`/v1/requests/${r.body.id}/evidence`).set(bearer(revisor))).body;
    expect(evid.review.reviewedBy).toContain('Rosa Revisora');
    expect(await atendido(r.body.id)).toBe('Ana Atiende');
    const texto = (await pdfPagesText(pdf)).join(' ');
    expect(texto).toContain('Ana Atiende');
    expect(texto).not.toContain('Rosa Revisora');
  });

  it('una persona que se da de baja o cambia de nombre después no cambia lo que dice un documento ya firmado', async () => {
    const r = await http().post('/v1/requests').set(bearer(ana)).send(cuerpo());
    await pool.query("UPDATE users SET name = 'Otro Nombre', active = false WHERE email = 'ana@a.test'");
    expect(await atendido(r.body.id)).toBe('Ana Atiende');
    await pool.query("UPDATE users SET name = 'Ana Atiende', active = true WHERE email = 'ana@a.test'");
  });

  describe('el pie de página como parte de la plantilla (panel)', () => {
    const publicar = (token: string, over: Record<string, unknown> = {}) =>
      http()
        .post('/v1/templates/APPOINTMENT_LETTER')
        .set(bearer(token))
        .send({
          blocks: BLOCKS,
          clauseText: 'Acepto.',
          policy: { otpRequired: true, photoRequired: false, photoChallengeRequired: false, idPhotoRequired: false, idPhotoBackRequired: false, reviewRequired: false },
          legalReviewed: false,
          publishedBy: 'Ana',
          ...over,
        });
    const pie = async () => (await http().get('/v1/templates/APPOINTMENT_LETTER').set(bearer(ana))).body.footer as string;

    it('el detalle de la plantilla lo devuelve, y las variables incluyen «attendedBy»', async () => {
      const d = (await http().get('/v1/templates/APPOINTMENT_LETTER').set(bearer(ana))).body;
      expect(d.footer).toBe(PIE);
      expect(d.variables.map((v: { name: string }) => v.name)).toContain('attendedBy');
    });

    it('al publicar se valida: variable inexistente, negrita sin pareja y largo; nada se publica', async () => {
      const antes = await pie();
      for (const malo of ['Hola {{noexiste}}', 'abre ** y no cierra', 'x'.repeat(401)]) {
        const r = await publicar(ana, { footer: malo });
        expect(r.status).toBe(422);
        expect(r.body.issues.some((i: { path: string }) => i.path === 'footer')).toBe(true);
      }
      expect(await pie()).toBe(antes);
    });

    it('sin el campo se conserva el pie; con texto lo cambia; vacío lo quita', async () => {
      expect((await publicar(ana)).status).toBe(201);
      expect(await pie()).toBe(PIE);
      expect((await publicar(ana, { footer: 'Solo {{signer.name}}' })).status).toBe(201);
      expect(await pie()).toBe('Solo {{signer.name}}');
      expect((await publicar(ana, { footer: '' })).status).toBe(201);
      expect(await pie()).toBe('');
      expect((await publicar(ana, { footer: PIE })).status).toBe(201);
    });

    it('la vista previa lo dibuja con datos de ejemplo y también lo valida', async () => {
      const ok = await http().post('/v1/templates/APPOINTMENT_LETTER/preview').set(bearer(ana)).send({ blocks: BLOCKS, footer: PIE, clauseText: 'x' });
      expect(ok.status).toBe(200);
      const texto = (await pdfPagesText(new Uint8Array(ok.body))).join(' ');
      expect(texto).toContain('Atendido por:');
      expect(texto).toContain('EJEMPLO');
      const mal = await http().post('/v1/templates/APPOINTMENT_LETTER/preview').set(bearer(ana)).send({ blocks: BLOCKS, footer: '{{nada}}', clauseText: 'x' });
      expect(mal.status).toBe(422);
    });
  });
});
