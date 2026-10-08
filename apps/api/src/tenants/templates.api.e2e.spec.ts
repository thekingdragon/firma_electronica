/**
 * API de plantillas (la que usa el panel): leer, publicar versiones, vista previa y aislamiento entre
 * corredoras. Requiere TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { makeApp, resetDatabase, testDatabaseUrl } from '../test-utils';
import { createTenant } from './tenants.service';

const URL_DB = testDatabaseUrl();
const T = 'APPOINTMENT_LETTER';

const blocks = (titulo = 'MI CARTA {{broker.legalName}}') => [
  { id: 'enc', type: 'issuerHeader', showRegistry: true, showDate: true },
  { id: 'tit', type: 'title', text: titulo },
  { id: 'par', type: 'paragraph', text: 'Yo, {{signer.name}}, con {{signer.documentType}} {{signer.documentNumber}}.' },
  { id: 'ramos', type: 'list', items: ['Riesgos generales', 'Riesgos humanos'], style: 'check' },
  { id: 'seg', type: 'dataList', dataKey: 'insurances', style: 'letters' },
  {
    id: 'fac',
    type: 'powers',
    intro: 'Facultades:',
    items: [
      { code: 'SINIESTRALIDAD', text: 'Solicitar la siniestralidad acumulada.', defaultChecked: true },
      { code: 'RENOVAR', text: 'Renovar pólizas.', defaultChecked: false },
    ],
    observation: { enabled: false, label: '', maxLength: 100 },
  },
  { id: 'firma', type: 'signerBox', title: 'Datos del firmante' },
  { id: 'sello', type: 'signatureStamp' },
  { id: 'a1', type: 'annex', title: 'ANEXO 1', subtitle: '', text: 'Obligaciones del corredor.\n\na. Asesorar.' },
];

const publicable = (over: Record<string, unknown> = {}) => ({
  blocks: blocks(),
  clauseText: 'Acepto firmar electrónicamente.',
  policy: { otpRequired: true, photoRequired: false, photoChallengeRequired: false, idPhotoRequired: false },
  legalReviewed: false,
  publishedBy: 'Gustavo (admin)',
  ...over,
});

describe('API de plantillas', () => {
  let app: INestApplication;
  let pool: Pool;
  let storageDir: string;
  let keyA: string;
  let keyB: string;
  let idA: string;

  const http = () => request(app.getHttpServer());
  const as = (key: string) => ({ 'X-Api-Key': key });

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    const a = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A SAC', registryCode: 'J701' });
    const b = await createTenant(pool, { name: 'B', country: 'PE', legalName: 'Corredora B SAC' });
    keyA = a.apiKey;
    keyB = b.apiKey;
    idA = a.tenant.id;
    storageDir = await mkdtemp(join(tmpdir(), 'fes-tplapi-'));
    app = await makeApp({
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      SECRETS_KEY: randomBytes(32).toString('base64'),
      STORAGE_DIR: storageDir,
      ALLOW_DEV_OTP: 'true',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  describe('lectura', () => {
    it('sin clave de API: 401 en todas las rutas', async () => {
      // Una por una: supertest cierra el servidor compartido al terminar cada petición.
      expect((await http().get('/v1/templates')).status).toBe(401);
      expect((await http().get(`/v1/templates/${T}`)).status).toBe(401);
      expect((await http().post(`/v1/templates/${T}`).send({})).status).toBe(401);
      expect((await http().post(`/v1/templates/${T}/preview`).send({})).status).toBe(401);
    });

    it('lista la versión activa de cada tipo', async () => {
      const r = await http().get('/v1/templates').set(as(keyA));
      expect(r.status).toBe(200);
      expect(r.body.items).toEqual([expect.objectContaining({ documentType: T, name: 'Carta de nombramiento', activeVersion: 1, legalReviewed: false })]);
    });

    it('la plantilla de partida nace por bloques e incluye variables, política y versiones', async () => {
      const r = await http().get(`/v1/templates/${T}`).set(as(keyA));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ version: 1, active: true, legacy: false });
      expect(r.body.blocks.map((b: { type: string }) => b.type)).toEqual(
        expect.arrayContaining(['issuerHeader', 'title', 'powers', 'signerBox', 'signatureStamp', 'annex']),
      );
      expect(r.body.policy).toEqual({ otpRequired: true, photoRequired: true, photoChallengeRequired: true, idPhotoRequired: true });
      expect(r.body.variables.map((v: { name: string }) => v.name)).toContain('signer.name');
      expect(r.body.versions).toEqual([expect.objectContaining({ version: 1, active: true })]);
      expect(r.body.clauseText).toContain('BORRADOR');
    });

    it('una plantilla guardada ANTES de los bloques se lee como los bloques equivalentes y avisa que es de la forma anterior', async () => {
      const t = await createTenant(pool, { name: 'L', country: 'PE', legalName: 'Legado SAC' });
      await pool.query(
        `UPDATE document_templates SET body_json = $2, annex_text = 'Obligaciones\n\na. Algo' WHERE tenant_id = $1`,
        [t.tenant.id, JSON.stringify({ legalReviewed: false, powers: [{ code: 'RENOVAR', text: 'Renovar', defaultChecked: true }], observation: { maxLength: 50 }, texts: { title: 'CARTA VIEJA' } })],
      );
      const r = await http().get(`/v1/templates/${T}`).set(as(t.apiKey));
      expect(r.status).toBe(200);
      expect(r.body.legacy).toBe(true);
      expect(r.body.blocks.find((b: { type: string }) => b.type === 'title').text).toBe('CARTA VIEJA');
      expect(r.body.blocks.some((b: { type: string }) => b.type === 'annex')).toBe(true);
    });

    it('un tipo inexistente o mal formado: 404', async () => {
      expect((await http().get('/v1/templates/NO_EXISTE').set(as(keyA))).status).toBe(404);
      expect((await http().get('/v1/templates/minuscula').set(as(keyA))).status).toBe(404);
      expect((await http().get(`/v1/templates/${T}/versions/99`).set(as(keyA))).status).toBe(404);
      expect((await http().get(`/v1/templates/${T}/versions/abc`).set(as(keyA))).status).toBe(404);
    });
  });

  describe('publicar', () => {
    it('crea la versión 2, la deja activa y desactiva la anterior; queda quién la publicó', async () => {
      const r = await http().post(`/v1/templates/${T}`).set(as(keyA)).send(publicable());
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ version: 2, previousVersion: 1 });

      const rows = (await pool.query(`SELECT version, active, published_by, annex_text, body_json FROM document_templates WHERE tenant_id=$1 ORDER BY version`, [idA])).rows;
      expect(rows.map((x) => [x.version, x.active])).toEqual([[1, false], [2, true]]);
      expect(rows[1].published_by).toBe('Gustavo (admin)');
      expect(rows[1].annex_text).toBeNull();
      expect(rows[1].body_json.blocks).toHaveLength(9);
      expect(rows[1].body_json.legalReviewed).toBe(false);

      const get = await http().get(`/v1/templates/${T}`).set(as(keyA));
      expect(get.body).toMatchObject({ version: 2, publishedBy: 'Gustavo (admin)' });
      expect(get.body.versions.map((v: { version: number; active: boolean }) => [v.version, v.active])).toEqual([[2, true], [1, false]]);
      expect(get.body.policy.photoRequired).toBe(false);
    });

    it('una versión anterior se puede consultar (para partir de ella) y no cambió', async () => {
      const v1 = await http().get(`/v1/templates/${T}/versions/1`).set(as(keyA));
      expect(v1.status).toBe(200);
      expect(v1.body).toMatchObject({ version: 1, active: false });
      expect(v1.body.policy.photoRequired).toBe(true);
    });

    it('quien publica puede marcar que el texto fue revisado', async () => {
      const r = await http().post(`/v1/templates/${T}`).set(as(keyA)).send(publicable({ legalReviewed: true }));
      expect(r.status).toBe(201);
      expect((await http().get(`/v1/templates/${T}`).set(as(keyA))).body.legalReviewed).toBe(true);
    });

    it('valida TODO y dice dónde está cada problema; no publica nada si hay uno', async () => {
      const antes = (await pool.query(`SELECT count(*)::int AS n FROM document_templates WHERE tenant_id=$1`, [idA])).rows[0].n;
      const mal = blocks();
      (mal[1] as { text: string }).text = 'Hola {{cliente.ruc}}';
      mal.push({ id: 'p2', type: 'powers', intro: '', items: [], observation: { enabled: false, label: '', maxLength: 10 } });
      const r = await http().post(`/v1/templates/${T}`).set(as(keyA)).send(publicable({ blocks: mal }));
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('VALIDATION_ERROR');
      const msgs = JSON.stringify(r.body.issues ?? r.body);
      expect(msgs).toContain('{{cliente.ruc}}');
      expect(msgs).toContain('powers');
      const despues = (await pool.query(`SELECT count(*)::int AS n FROM document_templates WHERE tenant_id=$1`, [idA])).rows[0].n;
      expect(despues).toBe(antes);
    });

    it('rechaza lo que no es de este contrato: campos de más, sin nombre de quien publica, cláusula vacía, política incoherente', async () => {
      const p = (over: Record<string, unknown>) => http().post(`/v1/templates/${T}`).set(as(keyA)).send(publicable(over));
      expect((await p({ extra: 1 })).status).toBe(422);
      expect((await p({ publishedBy: '' })).status).toBe(422);
      expect((await p({ clauseText: '   ' })).status).toBe(422);
      expect((await p({ policy: { otpRequired: true, photoRequired: false, photoChallengeRequired: true, idPhotoRequired: false } })).status).toBe(422);
      expect((await p({ policy: { otpRequired: true, photoRequired: false, photoChallengeRequired: false, idPhotoRequired: true } })).status).toBe(422);
      expect((await p({ blocks: [] })).status).toBe(422);
      expect((await p({ blocks: [{ id: 'x', type: 'script', text: '<script>' }] })).status).toBe(422);
    });

    it('un tipo que la corredora no tiene: 404', async () => {
      expect((await http().post('/v1/templates/OTRO_TIPO').set(as(keyA)).send(publicable())).status).toBe(404);
    });

    it('dos publicaciones a la vez: dos versiones distintas, una sola activa', async () => {
      const [r1, r2] = await Promise.all([
        http().post(`/v1/templates/${T}`).set(as(keyB)).send(publicable({ publishedBy: 'Uno' })),
        http().post(`/v1/templates/${T}`).set(as(keyB)).send(publicable({ publishedBy: 'Dos' })),
      ]);
      expect([r1.status, r2.status]).toEqual([201, 201]);
      expect(new Set([r1.body.version, r2.body.version]).size).toBe(2);
      const act = (await pool.query(`SELECT count(*)::int AS n FROM document_templates t JOIN tenants x ON x.id=t.tenant_id WHERE x.name='B' AND t.active`)).rows[0].n;
      expect(act).toBe(1);
    });
  });

  describe('aislamiento entre corredoras', () => {
    it('lo que publica una no cambia lo de la otra', async () => {
      const a = await http().get(`/v1/templates/${T}`).set(as(keyA));
      const b = await http().get(`/v1/templates/${T}`).set(as(keyB));
      expect(a.body.versions.map((v: { publishedBy: string | null }) => v.publishedBy)).toContain('Gustavo (admin)');
      expect(b.body.versions.map((v: { publishedBy: string | null }) => v.publishedBy)).not.toContain('Gustavo (admin)');
      // Y no se puede leer la versión de otra: el número de versión se busca solo entre las propias.
      const t = await createTenant(pool, { name: 'C', country: 'PE', legalName: 'C SAC' });
      expect((await http().get(`/v1/templates/${T}/versions/3`).set(as(t.apiKey))).status).toBe(404);
    });
  });

  describe('vista previa', () => {
    it('devuelve un PDF con lo que se está editando y no guarda nada', async () => {
      const antes = (await pool.query(`SELECT count(*)::int AS n FROM document_templates WHERE tenant_id=$1`, [idA])).rows[0].n;
      const r = await http().post(`/v1/templates/${T}/preview`).set(as(keyA)).send({ blocks: blocks('PREVISUALIZANDO'), clauseText: 'Clausula' }).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('application/pdf');
      expect(Buffer.from(r.body).subarray(0, 5).toString()).toBe('%PDF-');
      const despues = (await pool.query(`SELECT count(*)::int AS n FROM document_templates WHERE tenant_id=$1`, [idA])).rows[0].n;
      expect(despues).toBe(antes);
    });

    it('con bloques inválidos: 422 con el lugar del problema', async () => {
      const r = await http().post(`/v1/templates/${T}/preview`).set(as(keyA)).send({ blocks: [{ id: 'a', type: 'title', text: '{{no.existe}}' }] });
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.body)).toContain('{{no.existe}}');
    });
  });

  describe('lo publicado es lo que firma el cliente', () => {
    async function crearYVer(key: string) {
      const c = await http()
        .post('/v1/requests')
        .set(as(key))
        .send({
          documentType: T,
          externalRef: `ref-${randomBytes(4).toString('hex')}`,
          signer: { name: 'Ana Pérez Quispe', documentType: 'DNI', documentNumber: '12345678' },
          data: { insurances: ['SCTR Salud', 'SCTR Pensión'] },
          otp: { channel: 'EMAIL', to: 'ana@example.com' },
          delivery: { mode: 'HOST' },
        });
      expect(c.status).toBe(201);
      const token = (c.body.signUrl as string).split('/s/')[1];
      const otp = await http().post(`/v1/sign/${token}/otp`);
      expect(otp.status).toBe(200);
      const v = await http().post(`/v1/sign/${token}/verify`).send({ code: otp.body.devCode });
      expect(v.status).toBe(200);
      return { id: c.body.id as string, view: v.body.view };
    }

    it('una solicitud nueva usa la versión activa: el firmante ve los bloques de la corredora, con sus variables completas', async () => {
      await http().post(`/v1/templates/${T}`).set(as(keyA)).send(publicable({ blocks: blocks('CARTA DE {{broker.legalName}}') }));
      const { view } = await crearYVer(keyA);
      const tipos = view.blocks.map((b: { type: string }) => b.type);
      expect(tipos).toEqual(['issuerHeader', 'title', 'paragraph', 'list', 'list', 'powers', 'signerBox', 'signatureStamp', 'annex']);
      expect(view.blocks[1].text).toBe('CARTA DE Corredora A SAC');
      expect(view.blocks[2].text).toBe('Yo, Ana Pérez Quispe, con DNI 12345678.');
      expect(view.blocks[3]).toMatchObject({ style: 'check', items: ['Riesgos generales', 'Riesgos humanos'] });
      expect(view.blocks[4]).toMatchObject({ style: 'letters', items: ['SCTR Salud', 'SCTR Pensión'] });
      expect(view.blocks[5].items.map((i: { code: string }) => i.code)).toEqual(['SINIESTRALIDAD', 'RENOVAR']);
      expect(view.blocks[0]).toMatchObject({ legalName: 'Corredora A SAC', registryCode: 'J701' });
      expect(view.policy.photoRequired).toBe(false);
    });

    it('una solicitud ya creada conserva la versión con la que nació, aunque se publique otra después', async () => {
      const { id, view } = await crearYVer(keyA);
      const titulo = view.blocks.find((b: { type: string }) => b.type === 'title').text;
      await http().post(`/v1/templates/${T}`).set(as(keyA)).send(publicable({ blocks: blocks('TEXTO NUEVO') }));
      const row = (await pool.query(`SELECT d.version FROM signature_requests r JOIN document_templates d ON d.id = r.template_id WHERE r.id=$1`, [id])).rows[0];
      const activa = (await pool.query(`SELECT version FROM document_templates WHERE tenant_id=$1 AND active`, [idA])).rows[0];
      expect(row.version).toBeLessThan(activa.version);
      expect(titulo).not.toBe('TEXTO NUEVO');
    });

    it('un documento sin bloque de facultades no pide nada al firmante en el formulario', async () => {
      const sinFacultades = blocks().filter((b) => b.type !== 'powers');
      await http().post(`/v1/templates/${T}`).set(as(keyA)).send(publicable({ blocks: sinFacultades }));
      const { view } = await crearYVer(keyA);
      expect(view.blocks.some((b: { type: string }) => b.type === 'powers')).toBe(false);
    });
  });
});
