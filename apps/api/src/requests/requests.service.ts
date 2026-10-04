import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { canonicalJson } from '../common/canonical-json';
import { randomCode, sha256Hex, signTokenFor } from '../common/crypto';
import { AppConfig, APP_CONFIG } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { Tenant } from '../tenants/tenants.service';
import {
  AVAILABLE_CHANNELS,
  CreateRequestInput,
  createRequestSchema,
  isValidContact,
} from './create-request.dto';
import { DOCUMENT_TYPE_DATA_SCHEMAS } from './document-types';
import type { RequestStatus } from './request-status';

export interface SignatureRequestView {
  id: string;
  documentType: string;
  reference: string;
  status: RequestStatus;
  /** Solo con delivery.mode=HOST: el host es quien envía el link. */
  signUrl?: string;
  expiresAt: string;
  signedAt: string | null;
}

interface TemplateRow {
  id: string;
  otp_required: boolean;
}

interface RequestRow {
  id: string;
  document_type: string;
  reference: string;
  status: RequestStatus;
  snapshot_sha256: string;
  delivery_mode: 'SERVICE' | 'HOST';
  expires_at: Date;
  signed_at: Date | null;
}

const UQ_IDEMPOTENCY = 'signature_requests_tenant_id_idempotency_key_key';
const UQ_REFERENCE = 'signature_requests_tenant_id_reference_key';

const issues = (e: z.ZodError) =>
  e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

@Injectable()
export class RequestsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Valida el cuerpo crudo; devuelve el input listo o lanza 422 con el detalle por campo. */
  parseBody(body: unknown): CreateRequestInput {
    const parsed = createRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'El cuerpo de la petición no es válido.', {
        issues: issues(parsed.error),
      });
    }
    return parsed.data;
  }

  async create(
    tenant: Tenant,
    input: CreateRequestInput,
    idempotencyKey: string | undefined,
  ): Promise<{ view: SignatureRequestView; replay: boolean }> {
    if (idempotencyKey !== undefined && !/^[\x21-\x7E]{1,255}$/.test(idempotencyKey)) {
      throw new ApiError(
        422,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key debe tener entre 1 y 255 caracteres imprimibles, sin espacios.',
      );
    }

    // 1. Datos del tipo de documento.
    const dataSchema = DOCUMENT_TYPE_DATA_SCHEMAS[input.documentType];
    if (!dataSchema) {
      throw new ApiError(
        422,
        'DOCUMENT_TYPE_UNSUPPORTED',
        `El tipo de documento «${input.documentType}» no está soportado.`,
      );
    }
    const data = dataSchema.safeParse(input.data);
    if (!data.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', `«data» no es válido para ${input.documentType}.`, {
        issues: issues(data.error).map((i) => ({ ...i, path: `data.${i.path}` })),
      });
    }

    // 2. Plantilla activa del tenant para ese tipo: define la política de evidencia.
    const tpl = await this.pool.query<TemplateRow>(
      `SELECT id, otp_required FROM document_templates
        WHERE tenant_id = $1 AND document_type = $2 AND active`,
      [tenant.id, input.documentType],
    );
    if (!tpl.rows[0]) {
      throw new ApiError(
        422,
        'TEMPLATE_NOT_FOUND',
        `El tenant no tiene una plantilla activa para ${input.documentType}.`,
      );
    }
    const template = tpl.rows[0];

    // 3. Reglas que cruzan campos y plantilla.
    this.validateContacts(input, template.otp_required);

    // 4. El snapshot es TODO lo que mandó el host (ya validado y con valores por defecto). Su hash
    //    sirve de evidencia y para detectar una clave de idempotencia reutilizada con otro cuerpo.
    const snapshot = { ...input, data: data.data };
    const snapshotSha = sha256Hex(canonicalJson(snapshot));

    if (idempotencyKey !== undefined) {
      const existing = await this.findByIdempotencyKey(tenant.id, idempotencyKey);
      if (existing) return this.replay(existing, snapshotSha);
    }

    // 5. Insertar. La referencia es legible y única por tenant; ante una colisión (rarísima) se
    //    reintenta con otra. Una carrera por la misma Idempotency-Key se resuelve como replay.
    const id = randomUUID();
    const token = signTokenFor(id, this.config.tokenSecret);
    for (let intento = 0; intento < 5; intento++) {
      const reference = `FE-${new Date().getUTCFullYear()}-${randomCode(8)}`;
      try {
        const { rows } = await this.pool.query<RequestRow>(
          `INSERT INTO signature_requests
             (id, tenant_id, document_type, template_id, reference, external_ref, idempotency_key,
              snapshot, snapshot_sha256, otp_channel, otp_to, delivery_mode, delivery_channel,
              delivery_to, token_hash, webhook_url, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                   now() + make_interval(hours => $17))
           RETURNING id, document_type, reference, status, snapshot_sha256, delivery_mode,
                     expires_at, signed_at`,
          [
            id,
            tenant.id,
            input.documentType,
            template.id,
            reference,
            input.externalRef,
            idempotencyKey ?? null,
            JSON.stringify(snapshot),
            snapshotSha,
            input.otp?.channel ?? null,
            input.otp?.to ?? null,
            input.delivery.mode,
            input.delivery.channel ?? null,
            input.delivery.to ?? null,
            sha256Hex(token),
            input.webhookUrl ?? null,
            input.expiresInHours,
          ],
        );
        return { view: this.toView(rows[0]), replay: false };
      } catch (e) {
        const err = e as { code?: string; constraint?: string };
        if (err.code === '23505' && err.constraint === UQ_REFERENCE) continue;
        if (err.code === '23505' && err.constraint === UQ_IDEMPOTENCY && idempotencyKey !== undefined) {
          const existing = await this.findByIdempotencyKey(tenant.id, idempotencyKey);
          if (existing) return this.replay(existing, snapshotSha);
        }
        throw e;
      }
    }
    throw new ApiError(503, 'REFERENCE_UNAVAILABLE', 'No se pudo generar una referencia única; reintente.');
  }

  private validateContacts(input: CreateRequestInput, otpRequired: boolean): void {
    const fail = (code: string, message: string): never => {
      throw new ApiError(422, code, message);
    };

    if (otpRequired && !input.otp) {
      fail('OTP_REQUIRED', 'Este tipo de documento exige OTP: indique otp.channel y otp.to.');
    }
    if (input.otp) {
      if (!AVAILABLE_CHANNELS.includes(input.otp.channel)) {
        fail('CHANNEL_NOT_AVAILABLE', `El canal ${input.otp.channel} todavía no está disponible para el OTP.`);
      }
      if (!isValidContact(input.otp.channel, input.otp.to)) {
        fail('INVALID_CONTACT', `otp.to no tiene el formato de un canal ${input.otp.channel}.`);
      }
    }

    if (input.delivery.mode === 'HOST') {
      if (input.delivery.channel || input.delivery.to) {
        fail('INVALID_DELIVERY', 'delivery.channel y delivery.to solo aplican con mode=SERVICE.');
      }
    } else {
      // El envío por el servicio necesita el SMTP del tenant, que llega en un paso posterior de M1.
      fail('CHANNEL_NOT_AVAILABLE', 'El envío del link por el servicio todavía no está disponible: use delivery.mode=HOST.');
    }

    if (input.webhookUrl) {
      const url = new URL(input.webhookUrl);
      const secure = url.protocol === 'https:';
      if (!secure && this.config.isProduction) {
        fail('INVALID_WEBHOOK_URL', 'webhookUrl debe usar https.');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        fail('INVALID_WEBHOOK_URL', 'webhookUrl debe ser una URL http(s).');
      }
    }
  }

  private async findByIdempotencyKey(tenantId: string, key: string): Promise<RequestRow | null> {
    const { rows } = await this.pool.query<RequestRow>(
      `SELECT id, document_type, reference, status, snapshot_sha256, delivery_mode, expires_at, signed_at
         FROM signature_requests WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key],
    );
    return rows[0] ?? null;
  }

  private replay(existing: RequestRow, snapshotSha: string): { view: SignatureRequestView; replay: true } {
    if (existing.snapshot_sha256 !== snapshotSha) {
      throw new ApiError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Esa Idempotency-Key ya se usó con un cuerpo distinto.',
      );
    }
    return { view: this.toView(existing), replay: true };
  }

  private toView(r: RequestRow): SignatureRequestView {
    const view: SignatureRequestView = {
      id: r.id,
      documentType: r.document_type,
      reference: r.reference,
      status: r.status,
      expiresAt: r.expires_at.toISOString(),
      signedAt: r.signed_at ? r.signed_at.toISOString() : null,
    };
    if (r.delivery_mode === 'HOST') {
      const token = signTokenFor(r.id, this.config.tokenSecret);
      view.signUrl = `${this.config.publicBaseUrl}/s/${token}`;
    }
    return view;
  }
}
