import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { canonicalJson } from '../common/canonical-json';
import { randomCode, sha256Hex, signTokenFor } from '../common/crypto';
import { AppConfig, APP_CONFIG } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { imageInfo } from '../documents/image-info';
import { MailNotConfiguredError, MailSendError, MailService } from '../mail/mail.service';
import { maskEmail } from '../sign/otp';
import { StorageService } from '../storage/storage.service';
import { Tenant } from '../tenants/tenants.service';
import {
  AVAILABLE_CHANNELS,
  Channel,
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
  /** Solo con delivery.mode=SERVICE: dirección (enmascarada) a la que el servicio envió el link. */
  sentTo?: string;
  /** Avisos que no impiden crear la solicitud pero el host debería conocer. */
  warnings?: string[];
  expiresAt: string;
  signedAt: string | null;
}

/** Lo que ve el panel y el host al listar o abrir una solicitud. */
export interface SignatureRequestSummary extends SignatureRequestView {
  externalRef: string;
  signerName: string;
  /** Datos propios del tipo de documento (en la carta: los seguros nombrados). */
  data: Record<string, unknown>;
  createdAt: string;
  /** Dictamen del corredor sobre la evidencia, o `null` si aún no se revisó. */
  review: 'VERIFIED' | 'REJECTED' | null;
}

interface SummaryRow extends RequestRow {
  review_result: 'VERIFIED' | 'REJECTED' | null;
  external_ref: string;
  snapshot: { signer: { name: string }; data: Record<string, unknown> };
  created_at: Date;
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

/** U+FFFD, el carácter con que se decodifica un byte que no es UTF-8 válido. */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** Recorre el JSON buscando el carácter de reemplazo en cualquier texto, clave o valor. */
export function containsReplacementChar(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(REPLACEMENT_CHAR);
  if (Array.isArray(value)) return value.some(containsReplacementChar);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k.includes(REPLACEMENT_CHAR) || containsReplacementChar(v));
  }
  return false;
}

const issues = (e: z.ZodError) =>
  e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

@Injectable()
export class RequestsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageService,
    private readonly mail: MailService,
  ) {}

  /** Valida el cuerpo crudo; devuelve el input listo o lanza 422 con el detalle por campo. */
  parseBody(body: unknown): CreateRequestInput {
    // «�» (U+FFFD) aparece cuando el cliente mandó bytes que no eran UTF-8 válido (típico de una
    // terminal de Windows) y el servidor los decodificó con reemplazo. Aceptarlo guardaría un nombre
    // corrupto en un documento legal sin que quien lo envió se entere.
    if (containsReplacementChar(body)) {
      throw new ApiError(
        422,
        'INVALID_ENCODING',
        'El cuerpo contiene caracteres inválidos (�). Envíe el JSON codificado en UTF-8.',
      );
    }
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

    // El envío del link por el servicio necesita el correo del tenant: se comprueba ANTES de crear nada.
    const byService = input.delivery.mode === 'SERVICE';
    if (byService && !(await this.mail.isConfigured(tenant.id))) {
      throw new ApiError(
        409,
        'MAIL_NOT_CONFIGURED',
        'El tenant no tiene correo configurado: no se puede enviar el link desde el servicio. Use delivery.mode=HOST o configure el correo.',
      );
    }

    // 5. Insertar. La referencia es legible y única por tenant; ante una colisión (rarísima) se
    //    reintenta con otra. Una carrera por la misma Idempotency-Key se resuelve como replay.
    //    Todo en una transacción: si el envío del link falla, la solicitud NO queda creada, y el host
    //    puede reintentar con la misma Idempotency-Key sin dejar solicitudes huérfanas.
    const id = randomUUID();
    const token = signTokenFor(id, this.config.tokenSecret);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (let intento = 0; intento < 5; intento++) {
        const reference = `FE-${new Date().getUTCFullYear()}-${randomCode(8)}`;
        await client.query('SAVEPOINT insertar');
        try {
          const { rows } = await client.query<RequestRow>(
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
          await client.query('RELEASE SAVEPOINT insertar');

          const view = this.toView(rows[0]);
          if (byService) {
            await this.sendLink(tenant, input, rows[0], token);
            view.sentTo = maskEmail(input.delivery.to as string);
          }
          // Mismo buzón para el link y para el código: quien lo abra tiene los dos factores.
          if (byService && input.otp && input.otp.to.toLowerCase() === (input.delivery.to ?? '').toLowerCase()) {
            view.warnings = ['LINK_AND_OTP_SAME_CHANNEL'];
          }
          await client.query('COMMIT');
          return { view, replay: false };
        } catch (e) {
          const err = e as { code?: string; constraint?: string };
          if (err.code === '23505' && err.constraint === UQ_REFERENCE) {
            await client.query('ROLLBACK TO SAVEPOINT insertar');
            continue;
          }
          await client.query('ROLLBACK').catch(() => undefined);
          if (err.code === '23505' && err.constraint === UQ_IDEMPOTENCY && idempotencyKey !== undefined) {
            const existing = await this.findByIdempotencyKey(tenant.id, idempotencyKey);
            if (existing) return this.replay(existing, snapshotSha);
          }
          throw e;
        }
      }
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
    throw new ApiError(503, 'REFERENCE_UNAVAILABLE', 'No se pudo generar una referencia única; reintente.');
  }

  /** Envía el link de firma por correo, desde el servidor SMTP del tenant. Un fallo aborta la creación. */
  private async sendLink(tenant: Tenant, input: CreateRequestInput, row: RequestRow, token: string): Promise<void> {
    const url = `${this.config.publicBaseUrl}/s/${token}`;
    const vence = row.expires_at.toLocaleString('es-PE', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
    const text =
      `Hola ${input.signer.name},\n\n` +
      `${tenant.legalName} le envió un documento para firmar electrónicamente (ref. ${row.reference}).\n\n` +
      `Ábralo aquí: ${url}\n\n` +
      `El enlace vence el ${vence}. Si usted no esperaba este mensaje, ignórelo.`;
    try {
      await this.mail.send(tenant.id, {
        to: input.delivery.to as string,
        subject: `${tenant.legalName} le envió un documento para firmar`,
        text,
      });
    } catch (e) {
      if (e instanceof MailSendError || e instanceof MailNotConfiguredError) {
        // El detalle técnico ya quedó en tenant_mail_settings.last_error; al host se le da la explicación accionable.
        throw new ApiError(502, 'MAIL_SEND_FAILED', `No se pudo enviar el link por correo: ${e.message}`);
      }
      throw e;
    }
  }

  /** Solicitudes del tenant, las más nuevas primero. Nunca devuelve las de otro tenant. */
  async list(
    tenant: Tenant,
    opts: { status?: RequestStatus; limit: number },
  ): Promise<SignatureRequestSummary[]> {
    const { rows } = await this.pool.query<SummaryRow>(
      `SELECT r.id, r.document_type, r.reference, r.status, r.snapshot_sha256, r.delivery_mode, r.expires_at,
              r.signed_at, r.external_ref, r.snapshot, r.created_at, e.review_result
         FROM signature_requests r
         LEFT JOIN signature_evidence e ON e.request_id = r.id
        WHERE r.tenant_id = $1 AND ($2::request_status IS NULL OR r.status = $2::request_status)
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $3`,
      [tenant.id, opts.status ?? null, opts.limit],
    );
    return rows.map((r) => this.toSummary(r));
  }

  /** Una solicitud del tenant, o 404. Un id de otro tenant es indistinguible de uno inexistente. */
  async get(tenant: Tenant, id: string): Promise<SignatureRequestSummary> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Solicitud no encontrada.');
    }
    const { rows } = await this.pool.query<SummaryRow>(
      `SELECT r.id, r.document_type, r.reference, r.status, r.snapshot_sha256, r.delivery_mode, r.expires_at,
              r.signed_at, r.external_ref, r.snapshot, r.created_at, e.review_result
         FROM signature_requests r
         LEFT JOIN signature_evidence e ON e.request_id = r.id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenant.id, id],
    );
    if (!rows[0]) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Solicitud no encontrada.');
    return this.toSummary(rows[0]);
  }

  /**
   * El PDF firmado o la foto de verificación de una solicitud del tenant. La foto es un dato sensible:
   * solo se sirve a quien tiene la clave del tenant dueño de la solicitud.
   */
  async getFile(
    tenant: Tenant,
    id: string,
    kind: 'document' | 'photo',
  ): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    const notFound = () => new ApiError(404, 'REQUEST_NOT_FOUND', 'Solicitud no encontrada.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound();

    const { rows } = await this.pool.query<{ status: RequestStatus; reference: string; pdf_path: string | null; photo_path: string | null; photo_deleted_at: Date | null }>(
      `SELECT r.status, r.reference, r.pdf_path, e.photo_path, e.photo_deleted_at
         FROM signature_requests r
         LEFT JOIN signature_evidence e ON e.request_id = r.id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenant.id, id],
    );
    const row = rows[0];
    if (!row) throw notFound();

    if (kind === 'document') {
      if (row.status !== 'SIGNED' || !row.pdf_path) throw new ApiError(409, 'NOT_SIGNED', 'La solicitud todavía no está firmada.');
      return { bytes: await this.storage.get(row.pdf_path), contentType: 'application/pdf', filename: `${row.reference}.pdf` };
    }
    if (row.photo_deleted_at) {
      throw new ApiError(410, 'PHOTO_PURGED', 'La fotografía se borró al vencer el plazo de retención. Quedan sus huellas (hash) en la evidencia.');
    }
    if (!row.photo_path) throw new ApiError(404, 'PHOTO_NOT_FOUND', 'Esta solicitud no tiene fotografía.');
    const bytes = await this.storage.get(row.photo_path);
    const info = imageInfo(bytes);
    return {
      bytes,
      contentType: info?.mime ?? 'application/octet-stream',
      filename: `${row.reference}-foto.${info?.type === 'png' ? 'png' : 'jpg'}`,
    };
  }

  private toSummary(r: SummaryRow): SignatureRequestSummary {
    const view = this.toView(r);
    // El link solo sirve mientras la solicitud está pendiente.
    if (r.status !== 'PENDING') delete view.signUrl;
    return {
      ...view,
      externalRef: r.external_ref,
      signerName: r.snapshot.signer.name,
      data: r.snapshot.data,
      createdAt: r.created_at.toISOString(),
      review: r.review_result,
    };
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
      const { channel, to } = input.delivery;
      if (!channel || !to) fail('INVALID_DELIVERY', 'Con mode=SERVICE indique delivery.channel y delivery.to.');
      if (!AVAILABLE_CHANNELS.includes(channel as Channel)) {
        fail('CHANNEL_NOT_AVAILABLE', `El canal ${channel} todavía no está disponible para enviar el link.`);
      }
      if (!isValidContact(channel as Channel, to as string)) {
        fail('INVALID_CONTACT', `delivery.to no tiene el formato de un canal ${channel}.`);
      }
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
