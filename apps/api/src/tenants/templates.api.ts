import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { PG_POOL } from '../db/db.module';
import { Block, BlocksError, VARIABLES, resolveBlocks } from '../documents/blocks';
import { renderBlocksDocument } from '../documents/render-blocks';
import { PublishedTemplate, publishTemplate } from './templates.service';
import type { Tenant } from './tenants.service';

export interface TemplatePolicy {
  otpRequired: boolean;
  photoRequired: boolean;
  photoChallengeRequired: boolean;
  idPhotoRequired: boolean;
  idPhotoBackRequired: boolean;
  reviewRequired: boolean;
}

export interface TemplateVersionSummary {
  version: number;
  active: boolean;
  createdAt: string;
  publishedBy: string | null;
  legalReviewed: boolean;
}

export interface TemplateDetail extends TemplateVersionSummary {
  documentType: string;
  name: string;
  /** `true` si la versión se guardó antes de existir los bloques: los de abajo son los equivalentes. */
  legacy: boolean;
  blocks: Block[];
  clauseText: string;
  policy: TemplatePolicy;
  variables: ReadonlyArray<{ name: string; label: string }>;
  versions: TemplateVersionSummary[];
}

export interface TemplateListItem {
  documentType: string;
  name: string;
  activeVersion: number;
  legalReviewed: boolean;
  updatedAt: string;
  publishedBy: string | null;
}

const publishSchema = z
  .object({
    blocks: z.array(z.unknown()),
    clauseText: z.string().trim().min(1, 'La cláusula de aceptación no puede estar vacía.').max(5000),
    policy: z
      .object({
        otpRequired: z.boolean(),
        photoRequired: z.boolean(),
        photoChallengeRequired: z.boolean(),
        idPhotoRequired: z.boolean(),
        idPhotoBackRequired: z.boolean(),
        reviewRequired: z.boolean(),
      })
      .strict(),
    legalReviewed: z.boolean().default(false),
    publishedBy: z.string().trim().min(2, 'Indique su nombre: queda registrado como quien publicó.').max(120),
  })
  .strict();

const previewSchema = z.object({ blocks: z.array(z.unknown()), clauseText: z.string().max(5000).default('') }).strict();

const TYPE_RE = /^[A-Z][A-Z0-9_]*$/;

type Row = {
  id: string;
  document_type: string;
  name: string;
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
  published_by: string | null;
  created_at: Date;
};

@Injectable()
export class TemplatesApiService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private checkType(documentType: string): void {
    if (!TYPE_RE.test(documentType)) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Plantilla no encontrada.');
  }

  /** Una fila vieja o tocada a mano con bloques inválidos no tumba el panel: se informa con claridad. */
  private blocksOf(row: Row): Block[] {
    try {
      return resolveBlocks(row.body_json, row.annex_text);
    } catch (e) {
      if (e instanceof BlocksError) {
        throw new ApiError(500, 'TEMPLATE_INVALID', `La plantilla guardada no es válida: ${e.message}`);
      }
      throw e;
    }
  }

  async list(tenant: Tenant): Promise<{ items: TemplateListItem[] }> {
    const { rows } = await this.pool.query<Row>(
      `SELECT t.id, t.document_type, d.name, t.version, t.active, t.body_json, t.annex_text, t.clause_text,
              t.otp_required, t.photo_required, t.photo_challenge_required, t.id_photo_required, t.id_photo_back_required, t.review_required, t.published_by, t.created_at
         FROM document_templates t JOIN document_types d ON d.code = t.document_type
        WHERE t.tenant_id = $1 AND t.active
        ORDER BY d.name`,
      [tenant.id],
    );
    return {
      items: rows.map((r) => ({
        documentType: r.document_type,
        name: r.name,
        activeVersion: r.version,
        legalReviewed: r.body_json.legalReviewed === true,
        updatedAt: r.created_at.toISOString(),
        publishedBy: r.published_by,
      })),
    };
  }

  /** La versión activa, o la indicada. */
  async get(tenant: Tenant, documentType: string, version?: number): Promise<TemplateDetail> {
    this.checkType(documentType);
    const { rows } = await this.pool.query<Row>(
      `SELECT t.id, t.document_type, d.name, t.version, t.active, t.body_json, t.annex_text, t.clause_text,
              t.otp_required, t.photo_required, t.photo_challenge_required, t.id_photo_required, t.id_photo_back_required, t.review_required, t.published_by, t.created_at
         FROM document_templates t JOIN document_types d ON d.code = t.document_type
        WHERE t.tenant_id = $1 AND t.document_type = $2 AND ${version === undefined ? 't.active' : 't.version = $3'}`,
      version === undefined ? [tenant.id, documentType] : [tenant.id, documentType, version],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Plantilla no encontrada.');
    const all = await this.pool.query<Pick<Row, 'version' | 'active' | 'created_at' | 'published_by' | 'body_json'>>(
      `SELECT version, active, created_at, published_by, body_json FROM document_templates
        WHERE tenant_id = $1 AND document_type = $2 ORDER BY version DESC`,
      [tenant.id, documentType],
    );
    return {
      documentType: row.document_type,
      name: row.name,
      version: row.version,
      active: row.active,
      createdAt: row.created_at.toISOString(),
      publishedBy: row.published_by,
      legalReviewed: row.body_json.legalReviewed === true,
      legacy: row.body_json.blocks === undefined,
      blocks: this.blocksOf(row),
      clauseText: row.clause_text,
      policy: {
        otpRequired: row.otp_required,
        photoRequired: row.photo_required,
        photoChallengeRequired: row.photo_challenge_required,
        idPhotoRequired: row.id_photo_required,
        idPhotoBackRequired: row.id_photo_back_required,
        reviewRequired: row.review_required,
      },
      variables: VARIABLES,
      versions: all.rows.map((v) => ({
        version: v.version,
        active: v.active,
        createdAt: v.created_at.toISOString(),
        publishedBy: v.published_by,
        legalReviewed: v.body_json.legalReviewed === true,
      })),
    };
  }

  /** Publica una versión nueva (queda activa). Una versión publicada no se edita: solo se reemplaza. */
  async publish(tenant: Tenant, documentType: string, body: unknown): Promise<PublishedTemplate> {
    this.checkType(documentType);
    const parsed = publishSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos de la plantilla no son válidos.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const p = parsed.data;
    if (p.policy.photoChallengeRequired && !p.policy.photoRequired) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'El código de la foto exige que la foto sea obligatoria.');
    }
    if (p.policy.idPhotoRequired && !p.policy.photoRequired) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'La foto del documento exige que la foto de verificación sea obligatoria.');
    }
    if (p.policy.idPhotoBackRequired && !p.policy.idPhotoRequired) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'El reverso del documento exige que la foto del documento sea obligatoria.');
    }
    try {
      return await publishTemplate(this.pool, tenant.id, documentType, {
        blocks: p.blocks,
        clauseText: p.clauseText,
        otpRequired: p.policy.otpRequired,
        photoRequired: p.policy.photoRequired,
        photoChallengeRequired: p.policy.photoChallengeRequired,
        idPhotoRequired: p.policy.idPhotoRequired,
        idPhotoBackRequired: p.policy.idPhotoBackRequired,
        reviewRequired: p.policy.reviewRequired,
        legalReviewed: p.legalReviewed,
        publishedBy: p.publishedBy,
      });
    } catch (e) {
      if (e instanceof BlocksError) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Hay problemas en los bloques del documento.', { issues: e.issues });
      }
      if (e instanceof Error && /no tiene ninguna plantilla/.test(e.message)) {
        throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Plantilla no encontrada.');
      }
      throw e;
    }
  }

  /** PDF de muestra con lo que se está editando, para ver cómo queda ANTES de publicar. No guarda nada. */
  async preview(tenant: Tenant, documentType: string, body: unknown): Promise<Buffer> {
    this.checkType(documentType);
    const parsed = previewSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos de la vista previa no son válidos.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    let blocks: Block[];
    try {
      blocks = resolveBlocks({ blocks: parsed.data.blocks }, null);
    } catch (e) {
      if (e instanceof BlocksError) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Hay problemas en los bloques del documento.', { issues: e.issues });
      }
      throw e;
    }
    // Datos de muestra: cada lista de datos lleva dos ejemplos; todas las facultades marcadas.
    const data: Record<string, unknown> = {};
    for (const b of blocks) if (b.type === 'dataList') data[b.dataKey] = [`${b.dataKey} de ejemplo 1`, `${b.dataKey} de ejemplo 2`];
    const powers = blocks.flatMap((b) => (b.type === 'powers' ? b.items.map((i) => i.code) : []));
    const now = new Date();
    const pdf = await renderBlocksDocument({
      reference: 'VISTA-PREVIA',
      issuer: { legalName: tenant.legalName, registryCode: tenant.registryCode, timezone: tenant.timezone },
      signer: { name: 'NOMBRE APELLIDO (EJEMPLO)', documentType: 'DNI', documentNumber: '00000000' },
      data,
      content: { blocks: parsed.data.blocks },
      annexText: null,
      clauseText: parsed.data.clauseText || 'Texto de la cláusula de aceptación (ejemplo).',
      form: { powers, observation: 'Observación de ejemplo.' },
      signedAt: now,
      evidence: { ip: '127.0.0.1', otpVerifiedAt: now, challengeCode: '0000', photo: null, idPhoto: null, idPhotoBack: null },
    });
    return Buffer.from(pdf);
  }
}
