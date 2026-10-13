import { Pool } from 'pg';
import { parseBlocks, footerOf, footerProblems } from '../documents/blocks';

export interface TemplateChanges {
  /** Cláusula de aceptación electrónica que ve y acepta el firmante. */
  clauseText?: string;
  /** Anexo obligatorio del documento (en la carta: obligaciones del corredor). `null` lo quita. */
  annexText?: string | null;
  otpRequired?: boolean;
  photoRequired?: boolean;
  photoChallengeRequired?: boolean;
  idPhotoRequired?: boolean;
  idPhotoBackRequired?: boolean;
  reviewRequired?: boolean;
  /** Marca (o desmarca) que el texto pasó la revisión legal. Queda en el contenido de la plantilla. */
  legalReviewed?: boolean;
  /** Los bloques del documento (se validan al publicar). Reemplazan a los textos sueltos y al anexo anterior. */
  blocks?: unknown;
  /** Pie de página de cada hoja (texto con variables y negrita). `null` o vacío lo quita; sin este campo se conserva el anterior. */
  footer?: string | null;
  /** Quién la publica, para dejar constancia. */
  publishedBy?: string;
}

export interface PublishedTemplate {
  id: string;
  version: number;
  previousVersion: number | null;
}

const MAX_TEXT = 20_000;

/**
 * Publica una versión NUEVA de la plantilla de un tipo de documento para un tenant y la deja activa.
 *
 * Una versión usada no se edita nunca: las solicitudes ya creadas siguen apuntando a la versión con la
 * que se crearon (y así, el firmante ve —y el PDF lleva— exactamente el texto vigente cuando se le
 * envió el documento). Cambiar la redacción = una versión nueva. Lo que no se indique se hereda de la
 * versión activa.
 */
export async function publishTemplate(
  pool: Pool,
  tenantId: string,
  documentType: string,
  changes: TemplateChanges,
): Promise<PublishedTemplate> {
  if (changes.clauseText !== undefined && !changes.clauseText.trim()) throw new Error('La cláusula no puede estar vacía.');
  for (const [k, v] of Object.entries({ cláusula: changes.clauseText, anexo: changes.annexText })) {
    if (typeof v === 'string' && v.length > MAX_TEXT) throw new Error(`El texto del ${k} supera ${MAX_TEXT} caracteres.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializa las publicaciones del mismo tenant y tipo: dos a la vez se numerarían igual.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`template:${tenantId}:${documentType}`]);

    const { rows } = await client.query<{
      id: string;
      version: number;
      active: boolean;
      body_json: Record<string, unknown>;
      annex_text: string | null;
      clause_text: string;
      otp_required: boolean;
      photo_required: boolean;
      photo_challenge_required: boolean;
      id_photo_required: boolean;
      id_photo_back_required: boolean;
      review_required: boolean;
    }>(
      `SELECT id, version, active, body_json, annex_text, clause_text, otp_required, photo_required, photo_challenge_required, id_photo_required, id_photo_back_required, review_required
         FROM document_templates WHERE tenant_id = $1 AND document_type = $2
        ORDER BY active DESC, version DESC LIMIT 1`,
      [tenantId, documentType],
    );
    const base = rows[0];
    if (!base) throw new Error(`El tenant no tiene ninguna plantilla de ${documentType} de la cual partir.`);
    const max = await client.query<{ v: number }>(
      'SELECT max(version)::int AS v FROM document_templates WHERE tenant_id = $1 AND document_type = $2',
      [tenantId, documentType],
    );
    const version = (max.rows[0].v ?? 0) + 1;

    const photoRequired = changes.photoRequired ?? base.photo_required;
    const photoChallengeRequired = changes.photoChallengeRequired ?? base.photo_challenge_required;
    // La misma regla que protege la base (CHECK), dicha en claro antes de llegar a ella.
    if (photoChallengeRequired && !photoRequired) {
      throw new Error('El desafío de la foto exige que la foto sea obligatoria (photoChallengeRequired implica photoRequired).');
    }

    const idPhotoRequired = changes.idPhotoRequired ?? base.id_photo_required;
    if (idPhotoRequired && !photoRequired) {
      throw new Error('La foto del documento exige que la foto de verificación sea obligatoria (idPhotoRequired implica photoRequired).');
    }

    // El anexo de una plantilla por bloques es un bloque más: cambiar el campo suelto no haría nada y el
    // texto viejo seguiría firmándose sin que nadie lo note. Mejor negarse y decir dónde se edita.
    if (base.body_json.blocks !== undefined && changes.blocks === undefined && changes.annexText !== undefined) {
      throw new Error('Esta plantilla es por bloques: el anexo es un bloque más. Edítelo desde el panel (Plantillas).');
    }
    const idPhotoBackRequired = changes.idPhotoBackRequired ?? base.id_photo_back_required;
    if (idPhotoBackRequired && !idPhotoRequired) {
      throw new Error('El reverso del documento exige que la foto del documento sea obligatoria (idPhotoBackRequired implica idPhotoRequired).');
    }

    let body = { ...base.body_json };
    let annexText = changes.annexText !== undefined ? changes.annexText : base.annex_text;
    if (changes.blocks !== undefined) {
      // Con bloques, el anexo y los textos sueltos de la forma anterior ya no cuentan: todo vive en los bloques.
      body = { legalReviewed: false, blocks: parseBlocks(changes.blocks) };
      annexText = null;
    }
    if (changes.legalReviewed !== undefined) body.legalReviewed = changes.legalReviewed;
    // El pie de página no es un bloque: al reemplazar los bloques se conserva el que ya tenía, salvo que se indique otro.
    const previousFooter = footerOf(base.body_json);
    if (changes.footer !== undefined) {
      const text = (changes.footer ?? '').trim();
      const problems = footerProblems(text);
      if (problems.length) throw new Error(problems.join(' '));
      if (text) body.footer = text;
      else delete body.footer;
    } else if (previousFooter) {
      body.footer = previousFooter;
    }

    await client.query('UPDATE document_templates SET active = false WHERE tenant_id = $1 AND document_type = $2 AND active', [
      tenantId,
      documentType,
    ]);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO document_templates
         (tenant_id, document_type, version, body_json, annex_text, clause_text,
          otp_required, photo_required, photo_challenge_required, id_photo_required, id_photo_back_required, review_required, published_by, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
       RETURNING id`,
      [
        tenantId,
        documentType,
        version,
        JSON.stringify(body),
        annexText,
        changes.clauseText ?? base.clause_text,
        changes.otpRequired ?? base.otp_required,
        photoRequired,
        photoChallengeRequired,
        idPhotoRequired,
        idPhotoBackRequired,
        changes.reviewRequired ?? base.review_required,
        changes.publishedBy ?? null,
      ],
    );
    await client.query('COMMIT');
    return { id: ins.rows[0].id, version, previousVersion: base.active ? base.version : null };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
