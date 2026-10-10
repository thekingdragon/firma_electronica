import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Pool } from 'pg';
import { ApiError } from '../common/api-error';
import { sha256Hex } from '../common/crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { BlocksError, ViewBlock, resolveBlocks, toViewBlocks } from '../documents/blocks';
import { formatDate } from '../documents/render-blocks';
import { MailNotConfiguredError, MailSendError, MailService } from '../mail/mail.service';
import { OTP_POLICY, generateOtpCode, hashOtp, maskEmail, otpMatches } from './otp';
import { issueSessionToken, verifySessionToken } from './session-token';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

/** Lo que el firmante ve ANTES de verificar el OTP: lo mínimo, nada del contenido del documento. */
export interface SignIntro {
  reference: string;
  documentType: string;
  issuer: { name: string };
  otpRequired: boolean;
  /** Dirección enmascarada a la que se enviará el código. */
  otpTo: string | null;
  expiresAt: string;
}

export interface SigningView {
  reference: string;
  documentType: string;
  issuer: { legalName: string; registryCode: string | null };
  signer: { name: string; documentType: string; documentNumber: string };
  data: Record<string, unknown>;
  /** El documento como lista de bloques, con las variables ya completas: la página solo lo dibuja. */
  blocks: ViewBlock[];
  clause: { version: number; text: string };
  policy: { photoRequired: boolean; photoChallengeRequired: boolean; idPhotoRequired: boolean; idPhotoBackRequired: boolean; reviewRequired: boolean };
  expiresAt: string;
}

export interface LinkRow {
  id: string;
  tenant_id: string;
  document_type: string;
  reference: string;
  status: 'PENDING' | 'SIGNED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';
  expires_at: Date;
  expired: boolean;
  pdf_path: string | null;
  otp_channel: 'SMS' | 'WHATSAPP' | 'EMAIL' | null;
  otp_to: string | null;
  snapshot: { signer: SigningView['signer']; data: Record<string, unknown> };
  legal_name: string;
  registry_code: string | null;
  template_version: number;
  body_json: Record<string, unknown>;
  annex_text: string | null;
  clause_text: string;
  photo_required: boolean;
  photo_challenge_required: boolean;
  id_photo_required: boolean;
  id_photo_back_required: boolean;
  review_required: boolean;
}

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** `inet` solo acepta direcciones válidas: un valor raro no debe tumbar el registro de evidencia. */
export function toInet(ip: string | null): string | null {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, '');
  return isIP(clean) ? clean : null;
}

@Injectable()
export class SignService {
  private readonly logger = new Logger(SignService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mail: MailService,
  ) {}

  /** Busca la solicitud por su token y exige que siga abierta para firmar. */
  async open(token: string): Promise<LinkRow> {
    const row = await this.find(token);
    this.assertOpen(row);
    return row;
  }

  /** Busca por token SIN exigir que siga abierta (p. ej. para descargar la copia ya firmada). */
  async find(token: string): Promise<LinkRow> {
    if (!TOKEN_FORMAT.test(token)) throw this.notFound();
    const { rows } = await this.pool.query<LinkRow>(
      `SELECT r.id, r.tenant_id, r.document_type, r.reference, r.status, r.expires_at,
              (r.expires_at <= now()) AS expired, r.pdf_path,
              r.otp_channel, r.otp_to, r.snapshot,
              t.legal_name, t.registry_code,
              d.version AS template_version, d.body_json, d.annex_text, d.clause_text,
              d.photo_required, d.photo_challenge_required, d.id_photo_required, d.id_photo_back_required, d.review_required
         FROM signature_requests r
         JOIN tenants t ON t.id = r.tenant_id
         JOIN document_templates d ON d.id = r.template_id
        WHERE r.token_hash = $1`,
      [sha256Hex(token)],
    );
    if (!rows[0]) throw this.notFound();
    return rows[0];
  }

  private notFound(): ApiError {
    return new ApiError(404, 'LINK_NOT_FOUND', 'Este enlace no es válido.');
  }

  assertOpen(row: LinkRow): void {
    if (row.status === 'SIGNED') {
      throw new ApiError(410, 'ALREADY_SIGNED', 'Este documento ya fue firmado.');
    }
    if (row.status === 'REVOKED' || row.status === 'REJECTED') {
      throw new ApiError(410, 'LINK_REVOKED', 'Este enlace ya no está disponible. Contacte a su corredor.');
    }
    if (row.status === 'EXPIRED' || row.expired) {
      throw new ApiError(410, 'LINK_EXPIRED', 'Este enlace venció. Pida uno nuevo a su corredor.');
    }
  }

  async intro(token: string, ctx: ClientContext): Promise<SignIntro> {
    const row = await this.open(token);
    await this.log(row.id, 'link_opened', ctx);
    return {
      reference: row.reference,
      documentType: row.document_type,
      issuer: { name: row.legal_name },
      otpRequired: row.otp_channel !== null,
      otpTo: row.otp_channel === 'EMAIL' && row.otp_to ? maskEmail(row.otp_to) : null,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /** Genera un código nuevo, lo envía y deja vigente solo ese. Devuelve el código solo en modo desarrollo. */
  async requestOtp(token: string, ctx: ClientContext): Promise<{ sentTo: string; cooldownSeconds: number; devCode?: string }> {
    const row = await this.open(token);
    if (!row.otp_channel || !row.otp_to) {
      throw new ApiError(409, 'OTP_NOT_REQUIRED', 'Este documento no requiere código de verificación.');
    }
    const configured = await this.mail.isConfigured(row.tenant_id);
    if (!configured && !this.config.allowDevOtp) {
      throw new ApiError(
        409,
        'MAIL_NOT_CONFIGURED',
        'No se puede enviar el código: su corredor aún no configuró el envío de correos. Contáctelo.',
      );
    }

    const code = generateOtpCode();
    const challengeId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serializa los pedidos de código de UNA solicitud: sin esto, dos clics a la vez pasarían ambos
      // el enfriamiento y saldrían dos correos.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp:${row.id}`]);

      const limits = await client.query<{ wait: string | null; sends: string }>(
        `SELECT ceil($2::numeric - extract(epoch FROM now() - max(sent_at)))::int AS wait,
                count(*) FILTER (WHERE sent_at > now() - interval '1 hour')::int AS sends
           FROM otp_challenges WHERE request_id = $1 AND sent_at IS NOT NULL`,
        [row.id, OTP_POLICY.cooldownSeconds],
      );
      const wait = limits.rows[0].wait === null ? 0 : Number(limits.rows[0].wait);
      if (wait > 0) {
        throw new ApiError(429, 'OTP_COOLDOWN', `Espere ${wait} segundos para pedir otro código.`, { retryAfterSeconds: wait });
      }
      if (Number(limits.rows[0].sends) >= OTP_POLICY.maxSendsPerHour) {
        throw new ApiError(429, 'OTP_RATE_LIMITED', 'Pidió demasiados códigos. Intente de nuevo en una hora.');
      }

      await client.query(
        `INSERT INTO otp_challenges (id, request_id, code_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
        [challengeId, row.id, hashOtp(this.config.tokenSecret, challengeId, code), OTP_POLICY.ttlSeconds],
      );

      if (configured) {
        try {
          await this.mail.send(row.tenant_id, this.otpMessage(row, code));
        } catch (e) {
          if (e instanceof MailSendError || e instanceof MailNotConfiguredError) {
            // El detalle técnico ya quedó en tenant_mail_settings.last_error; al firmante no se le muestra.
            throw new ApiError(502, 'MAIL_SEND_FAILED', 'No se pudo enviar el código. Intente de nuevo en un momento o contacte a su corredor.');
          }
          throw e;
        }
      }

      await client.query('UPDATE otp_challenges SET sent_at = now() WHERE id = $1', [challengeId]);
      await client.query(
        `UPDATE otp_challenges SET superseded_at = now()
          WHERE request_id = $1 AND id <> $2 AND superseded_at IS NULL AND consumed_at IS NULL`,
        [row.id, challengeId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }

    await this.log(row.id, configured ? 'otp_sent' : 'otp_issued_dev', ctx);
    return {
      sentTo: maskEmail(row.otp_to),
      cooldownSeconds: OTP_POLICY.cooldownSeconds,
      ...(configured ? {} : { devCode: code }),
    };
  }

  async verify(token: string, code: string | undefined, ctx: ClientContext): Promise<{ sessionToken: string; expiresAt: string; view: SigningView }> {
    const row = await this.open(token);

    if (row.otp_channel) {
      if (code === undefined || !/^\d{6}$/.test(code)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'El código tiene 6 dígitos.');
      }
      await this.checkOtp(row, code, ctx);
    }

    const session = issueSessionToken(this.config.tokenSecret, row.id);
    await this.log(row.id, 'session_opened', ctx);
    return { sessionToken: session.token, expiresAt: session.expiresAt.toISOString(), view: this.buildView(row) };
  }

  /** Abre el documento con una sesión ya verificada (p. ej. al recargar la página). */
  async view(token: string, sessionToken: string | undefined): Promise<SigningView> {
    const row = await this.open(token);
    this.assertSession(row, sessionToken);
    return this.buildView(row);
  }

  /** La sesión debe ser válida y de ESTA solicitud. */
  assertSession(row: LinkRow, sessionToken: string | undefined): void {
    if (!sessionToken || !verifySessionToken(this.config.tokenSecret, sessionToken, row.id)) {
      throw new ApiError(401, 'SESSION_INVALID', 'Su sesión venció. Vuelva a verificar su código.');
    }
  }

  private async checkOtp(row: LinkRow, code: string, ctx: ClientContext): Promise<void> {
    const live = await this.pool.query<{ id: string; code_hash: string; expired: boolean }>(
      `SELECT id, code_hash, (expires_at <= now()) AS expired
         FROM otp_challenges
        WHERE request_id = $1 AND sent_at IS NOT NULL AND consumed_at IS NULL AND superseded_at IS NULL
        ORDER BY sent_at DESC LIMIT 1`,
      [row.id],
    );
    const ch = live.rows[0];
    if (!ch) throw new ApiError(401, 'OTP_NOT_REQUESTED', 'Solicite un código de verificación.');
    if (ch.expired) throw new ApiError(401, 'OTP_EXPIRED', 'El código venció. Solicite uno nuevo.');

    // Se cuenta el intento ANTES de comparar y de forma atómica: así, aunque lleguen 100 intentos en
    // paralelo, solo los primeros `maxAttempts` llegan a compararse.
    const counted = await this.pool.query<{ attempts: number }>(
      `UPDATE otp_challenges SET attempts = attempts + 1
        WHERE id = $1 AND attempts < $2 AND consumed_at IS NULL
        RETURNING attempts`,
      [ch.id, OTP_POLICY.maxAttempts],
    );
    if (!counted.rows[0]) {
      await this.log(row.id, 'otp_locked', ctx);
      throw new ApiError(429, 'OTP_LOCKED', 'Demasiados intentos. Solicite un código nuevo.');
    }
    const attempts = counted.rows[0].attempts;

    if (otpMatches(this.config.tokenSecret, ch.id, code, ch.code_hash)) {
      const consumed = await this.pool.query(
        'UPDATE otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
        [ch.id],
      );
      if (consumed.rowCount) {
        await this.log(row.id, 'otp_verified', ctx);
        return;
      }
    }
    await this.log(row.id, 'otp_failed', ctx, { attempts });
    throw new ApiError(401, 'OTP_INVALID', 'El código no es correcto.', {
      attemptsLeft: Math.max(0, OTP_POLICY.maxAttempts - attempts),
    });
  }

  private viewBlocks(row: LinkRow): ViewBlock[] {
    try {
      return toViewBlocks(
        resolveBlocks(row.body_json, row.annex_text),
        {
          brokerLegalName: row.legal_name,
          brokerRegistryCode: row.registry_code,
          signerName: row.snapshot.signer.name,
          signerDocumentType: row.snapshot.signer.documentType,
          signerDocumentNumber: row.snapshot.signer.documentNumber,
          reference: row.reference,
          date: formatDate(new Date()),
        },
        row.snapshot.data,
      );
    } catch (e) {
      if (e instanceof BlocksError) {
        throw new ApiError(503, 'TEMPLATE_INVALID', 'La plantilla de este documento no es válida. Contacte a su corredor.');
      }
      throw e;
    }
  }

  private buildView(row: LinkRow): SigningView {
    return {
      reference: row.reference,
      documentType: row.document_type,
      issuer: { legalName: row.legal_name, registryCode: row.registry_code },
      signer: row.snapshot.signer,
      data: row.snapshot.data,
      blocks: this.viewBlocks(row),
      clause: { version: row.template_version, text: row.clause_text },
      policy: { photoRequired: row.photo_required, photoChallengeRequired: row.photo_challenge_required, idPhotoRequired: row.id_photo_required, idPhotoBackRequired: row.id_photo_back_required, reviewRequired: row.review_required },
      expiresAt: row.expires_at.toISOString(),
    };
  }

  private otpMessage(row: LinkRow, code: string) {
    const minutes = Math.round(OTP_POLICY.ttlSeconds / 60);
    const text =
      `Su código de verificación es: ${code}\n\n` +
      `Úselo para firmar el documento ${row.reference} de ${row.legal_name}. ` +
      `Vence en ${minutes} minutos.\n\n` +
      `Si usted no lo solicitó, ignore este correo y no comparta el código con nadie.`;
    const html =
      `<p>Su código de verificación es:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:8px 0">${code}</p>` +
      `<p>Úselo para firmar el documento <strong>${row.reference}</strong> de ${escapeHtml(row.legal_name)}. ` +
      `Vence en ${minutes} minutos.</p>` +
      `<p style="color:#666">Si usted no lo solicitó, ignore este correo y no comparta el código con nadie.</p>`;
    return { to: row.otp_to as string, subject: 'Su código de verificación para firmar', text, html };
  }

  async log(requestId: string, event: string, ctx: ClientContext, detail?: Record<string, unknown>): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO access_log (request_id, event, ip, user_agent, detail) VALUES ($1, $2, $3, $4, $5)',
        [requestId, event, toInet(ctx.ip), ctx.userAgent?.slice(0, 500) ?? null, detail ? JSON.stringify(detail) : null],
      );
    } catch (e) {
      // La bitácora no debe tumbar la operación del firmante, pero un fallo de auditoría no puede pasar callado.
      this.logger.error(`No se pudo registrar el evento ${event} de ${requestId}: ${(e as Error).message}`);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
