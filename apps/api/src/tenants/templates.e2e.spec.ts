/**
 * Pruebas de integración de la publicación de plantillas. Requieren TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { makeApp, resetDatabase, testDatabaseUrl } from '../test-utils';
import { publishTemplate } from './templates.service';
import { createTenant } from './tenants.service';

const URL_DB = testDatabaseUrl();
const body = {
  documentType: 'APPOINTMENT_LETTER',
  externalRef: 'x',
  signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '1' },
  data: { insurances: ['SCTR'] },
  delivery: { mode: 'HOST' },
};

describe('publicar una versión de la plantilla', () => {
  let app: INestApplication;
  let pool: Pool;
  let key: string;
  let tenantId: string;
  let storageDir: string;

  const http = () => request(app.getHttpServer());
  const active = async (id = tenantId) =>
    (await pool.query(`SELECT version, clause_text, annex_text, otp_required, photo_required, photo_challenge_required, body_json FROM document_templates WHERE tenant_id=$1 AND document_type='APPOINTMENT_LETTER' AND active`, [id])).rows;

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    const t = await createTenant(pool, { name: 'T', country: 'PE', legalName: 'T SAC' });
    key = t.apiKey;
    tenantId = t.tenant.id;
    await pool.query(`UPDATE document_templates SET otp_required=false, photo_required=false, photo_challenge_required=false, id_photo_required=false WHERE tenant_id=$1`, [tenantId]);
    storageDir = await mkdtemp(join(tmpdir(), 'fes-tpl-'));
    app = await makeApp({
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      SECRETS_KEY: randomBytes(32).toString('base64'),
      STORAGE_DIR: storageDir,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  async function crear() {
    const r = await http().post('/v1/requests').set('X-Api-Key', key).send(body);
    expect(r.status).toBe(201);
    return (r.body.signUrl as string).split('/s/')[1];
  }
  async function clausulaQueVe(token: string) {
    const v = await http().post(`/v1/sign/${token}/verify`).send({});
    expect(v.status).toBe(200);
    return { clause: v.body.view.clause.text as string, version: v.body.view.clause.version as number };
  }

  it('nace en BORRADOR (versión 1) y publicar crea la versión 2 activa, dejando la 1 inactiva', async () => {
    expect((await active())[0]).toMatchObject({ version: 1 });
    expect((await active())[0].clause_text).toContain('BORRADOR');
    expect((await active())[0].body_json.legalReviewed).toBe(false);

    const r = await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { clauseText: 'Texto definitivo revisado.', legalReviewed: true });
    expect(r.version).toBe(2);
    expect(r.previousVersion).toBe(1);

    const act = await active();
    expect(act).toHaveLength(1); // una sola activa
    expect(act[0]).toMatchObject({ version: 2, clause_text: 'Texto definitivo revisado.' });
    expect(act[0].body_json.legalReviewed).toBe(true);
    const todas = (await pool.query(`SELECT version, active FROM document_templates WHERE tenant_id=$1 ORDER BY version`, [tenantId])).rows;
    expect(todas).toEqual([{ version: 1, active: false }, { version: 2, active: true }]);
  });

  it('lo que no se indica se hereda de la versión activa (anexo, política, facultades)', async () => {
    const antes = (await active())[0];
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { photoRequired: true });
    const despues = (await active())[0];
    expect(despues.version).toBe(antes.version + 1);
    expect(despues.clause_text).toBe(antes.clause_text);
    expect(despues.annex_text).toBe(antes.annex_text);
    expect(despues.photo_required).toBe(true);
    expect(despues.otp_required).toBe(antes.otp_required);
    expect(despues.body_json.powers).toEqual(antes.body_json.powers);
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { photoRequired: false });
  });

  it('una solicitud YA creada conserva la cláusula de la versión con la que se creó; las nuevas usan la vigente', async () => {
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { clauseText: 'CLÁUSULA A' });
    const tokenA = await crear();
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { clauseText: 'CLÁUSULA B' });
    const tokenB = await crear();

    const a = await clausulaQueVe(tokenA);
    const b = await clausulaQueVe(tokenB);
    expect(a.clause).toBe('CLÁUSULA A'); // lo que se le prometió al firmante al crear su solicitud
    expect(b.clause).toBe('CLÁUSULA B');
    expect(b.version).toBe(a.version + 1);
  });

  it('la evidencia de la firma guarda la cláusula de SU versión (la que vio el firmante), no la posterior', async () => {
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { clauseText: 'CLÁUSULA DEL PDF' });
    const token = await crear();
    const v = await http().post(`/v1/sign/${token}/verify`).send({}).expect(200);
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { clauseText: 'CLÁUSULA POSTERIOR' });
    await http()
      .post(`/v1/sign/${token}/submit`)
      .set('X-Session', v.body.sessionToken)
      .field('accepted', 'true')
      .field('form', JSON.stringify({ powers: ['RENOVACIONES'], observation: '' }))
      .expect(200);
    const ev = (await pool.query(`SELECT clause_text FROM signature_evidence e JOIN signature_requests r ON r.id=e.request_id WHERE r.token_hash IS NOT NULL ORDER BY e.captured_at DESC LIMIT 1`)).rows[0];
    expect(ev.clause_text).toBe('CLÁUSULA DEL PDF');
  });

  it('en una plantilla por bloques, cambiar el anexo suelto se rechaza: el anexo es un bloque y se edita en el panel', async () => {
    const antes = (await active())[0];
    expect(antes.body_json.blocks).toBeDefined();
    await expect(publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { annexText: 'Anexo nuevo' })).rejects.toThrow(/por bloques/);
    expect((await active())[0].version).toBe(antes.version); // no se publicó nada
  });

  it('en una plantilla guardada ANTES de los bloques, el anexo suelto se puede cambiar y quitar con null', async () => {
    const t = await createTenant(pool, { name: 'Legado', country: 'PE', legalName: 'Legado SAC' });
    await pool.query(
      `UPDATE document_templates SET body_json = $2, annex_text = 'Anexo viejo' WHERE tenant_id = $1`,
      [t.tenant.id, JSON.stringify({ legalReviewed: false, powers: [], observation: { maxLength: 100 } })],
    );
    await publishTemplate(pool, t.tenant.id, 'APPOINTMENT_LETTER', { annexText: 'Anexo nuevo' });
    expect((await active(t.tenant.id))[0].annex_text).toBe('Anexo nuevo');
    await publishTemplate(pool, t.tenant.id, 'APPOINTMENT_LETTER', { annexText: null });
    expect((await active(t.tenant.id))[0].annex_text).toBeNull();
  });

  it('publicar bloques nuevos reemplaza al anexo suelto y a los textos anteriores', async () => {
    const t = await createTenant(pool, { name: 'Legado2', country: 'PE', legalName: 'Legado2 SAC' });
    await pool.query(`UPDATE document_templates SET body_json = $2, annex_text = 'Anexo viejo' WHERE tenant_id = $1`, [
      t.tenant.id,
      JSON.stringify({ legalReviewed: true, powers: [], texts: { title: 'VIEJO' } }),
    ]);
    await publishTemplate(pool, t.tenant.id, 'APPOINTMENT_LETTER', { blocks: [{ id: 'a', type: 'title', text: 'NUEVO' }] });
    const row = (await active(t.tenant.id))[0];
    expect(row.annex_text).toBeNull();
    expect(row.body_json).toEqual({ legalReviewed: false, blocks: [expect.objectContaining({ type: 'title', text: 'NUEVO' })] });
  });

  it('rechaza una cláusula vacía o gigante, y un desafío sin foto, sin dejar nada a medias', async () => {
    const antes = (await pool.query('SELECT count(*)::int AS n FROM document_templates WHERE tenant_id=$1', [tenantId])).rows[0].n;
    const activaAntes = (await active())[0].version;
    await expect(publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { clauseText: '   ' })).rejects.toThrow(/vacía/);
    await expect(publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { clauseText: 'x'.repeat(20_001) })).rejects.toThrow(/supera/);
    await expect(publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { photoRequired: false, photoChallengeRequired: true })).rejects.toThrow(/exige que la foto/);
    expect((await pool.query('SELECT count(*)::int AS n FROM document_templates WHERE tenant_id=$1', [tenantId])).rows[0].n).toBe(antes);
    expect((await active())[0].version).toBe(activaAntes); // la activa NO se desactivó
  });

  it('un tenant o tipo sin plantilla da un error claro', async () => {
    await expect(publishTemplate(pool, '00000000-0000-4000-8000-000000000000', 'APPOINTMENT_LETTER', { otpRequired: true })).rejects.toThrow(/ninguna plantilla/);
    await expect(publishTemplate(pool, tenantId, 'OTRO_TIPO', { otpRequired: true })).rejects.toThrow(/ninguna plantilla/);
  });

  it('varias publicaciones a la vez: todas con versión distinta y UNA sola activa', async () => {
    // Con solo dos casi nunca se traslapan; con ocho la carrera es real y sin el candado fallan por duplicado.
    const r = await Promise.all(
      Array.from({ length: 8 }, (_, i) => publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { clauseText: `concurrente ${i}` })),
    );
    const versiones = r.map((x) => x.version);
    expect(new Set(versiones).size).toBe(8);
    expect(await active()).toHaveLength(1);
    expect((await active())[0].version).toBe(Math.max(...versiones));
  });

  it('la plantilla de un tenant no toca la de otro', async () => {
    const otro = await createTenant(pool, { name: 'Otro', country: 'PE', legalName: 'Otro SAC' });
    const antes = (await active(otro.tenant.id))[0];
    await publishTemplate(pool, tenantId, 'APPOINTMENT_LETTER', { clauseText: 'solo del primero' });
    expect((await active(otro.tenant.id))[0]).toEqual(antes);
  });
});
