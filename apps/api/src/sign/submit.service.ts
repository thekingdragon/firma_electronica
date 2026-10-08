import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { PG_POOL } from '../db/db.module';
import { formSchemaFor } from '../documents/form-schemas';
import { imageInfo } from '../documents/image-info';
import { renderDocument, resolveContent } from '../documents/render';
import { enqueueWebhook } from '../webhooks/outbox';
import { MailService } from '../mail/mail.service';
import { StorageNotConfiguredError, StorageService } from '../storage/storage.service';
import { PHOTO_POLICY, checkResolution, generateChallengeCode } from './photo';
import { ClientContext, LinkRow, SignService, toInet } from './sign.service';
import { createHash } from 'node:crypto';

export interface SubmitInput {
  photo: Buffer | undefined;
  idPhoto: Buffer | undefined;
  idPhotoBack: Buffer | undefined;
  challengeId: string | undefined;
  accepted: unknown;
  form: unknown;
  clientInfo: unknown;
}

export interface SubmitResult {
  reference: string;
  signedAt: string;
  pdfSha256: string;
  /** `true` solo si el servicio SÍ va a mandar la copia por correo (hay correo del firmante y SMTP del tenant). */
  emailed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Datos informativos del navegador: acotados, porque los manda el cliente. */
const clientInfoSchema = z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])).refine(
  (o) => Object.keys(o).length <= 20,
  'demasiados campos',
);

/** `value` viene de un campo multipart (texto): puede ser JSON como string, o ya un objeto. */
function parseJsonField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

@Injectable()
export class SubmitService implements OnApplicationShutdown {
  private readonly logger = new Logger(SubmitService.name);
  /** Correos de confirmación en vuelo: se esperan al apagar para no perderlos. */
  private readonly pendingConfirmations = new Set<Promise<void>>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly sign: SignService,
    private readonly storage: StorageService,
    private readonly mail: MailService,
  ) {}

  /** Emite un código nuevo para la foto; el anterior deja de valer. Requiere sesión verificada. */
  async issueChallenge(
    token: string,
    sessionToken: string | undefined,
    ctx: ClientContext,
  ): Promise<{ challengeId: string; code: string; expiresAt: string }> {
    const row = await this.sign.open(token);
    this.sign.assertSession(row, sessionToken);
    if (!row.photo_challenge_required) {
      throw new ApiError(409, 'CHALLENGE_NOT_REQUIRED', 'Este documento no requiere código para la foto.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`challenge:${row.id}`]);
      const { rows: recent } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM photo_challenges WHERE request_id = $1 AND issued_at > now() - interval '1 hour'`,
        [row.id],
      );
      if (recent[0].n >= PHOTO_POLICY.maxChallengesPerHour) {
        throw new ApiError(429, 'CHALLENGE_RATE_LIMITED', 'Pidió demasiados códigos. Intente de nuevo en una hora.');
      }
      await client.query(
        `UPDATE photo_challenges SET superseded_at = now()
          WHERE request_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
        [row.id],
      );
      const code = generateChallengeCode();
      const { rows } = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO photo_challenges (request_id, code, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))
         RETURNING id, expires_at`,
        [row.id, code, PHOTO_POLICY.challengeTtlSeconds],
      );
      await client.query('COMMIT');
      await this.sign.log(row.id, 'photo_challenge_issued', ctx);
      return { challengeId: rows[0].id, code, expiresAt: rows[0].expires_at.toISOString() };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Firma el documento: valida todo, genera el PDF, guarda foto y PDF cifrados y deja la evidencia,
   * en UNA transacción con la solicitud bloqueada (dos envíos a la vez no pueden firmar dos veces).
   */
  async submit(token: string, sessionToken: string | undefined, input: SubmitInput, ctx: ClientContext): Promise<SubmitResult> {
    const link = await this.sign.open(token);
    this.sign.assertSession(link, sessionToken);

    // --- Validación que no necesita la base ---
    if (input.accepted !== true && input.accepted !== 'true') {
      throw new ApiError(422, 'ACCEPTANCE_REQUIRED', 'Debe aceptar la cláusula para firmar.');
    }

    const formSchema = formSchemaFor(link.document_type, link.body_json);
    if (!formSchema) {
      throw new ApiError(422, 'DOCUMENT_TYPE_UNSUPPORTED', 'Este tipo de documento no se puede firmar todavía.');
    }
    const formParsed = formSchema.safeParse(parseJsonField(input.form));
    if (!formParsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos del formulario no son válidos.', {
        issues: formParsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const form = formParsed.data;

    const ci = clientInfoSchema.safeParse(parseJsonField(input.clientInfo));
    const clientInfo = ci.success ? ci.data : {};

    if (link.photo_required && !input.photo) {
      throw new ApiError(422, 'PHOTO_REQUIRED', 'Falta la fotografía de verificación.');
    }
    if (link.id_photo_required && !input.idPhoto) {
      throw new ApiError(422, 'ID_PHOTO_REQUIRED', 'Falta la fotografía de su documento de identidad.');
    }
    const photo = input.photo ? this.checkedImage(input.photo, 'PHOTO') : null;
    if (link.id_photo_back_required && !input.idPhotoBack) {
      throw new ApiError(422, 'ID_PHOTO_BACK_REQUIRED', 'Falta la fotografía del reverso de su documento de identidad.');
    }
    const idPhoto = input.idPhoto ? this.checkedImage(input.idPhoto, 'ID_PHOTO') : null;
    const idPhotoBack = input.idPhotoBack ? this.checkedImage(input.idPhotoBack, 'ID_PHOTO_BACK') : null;
    if (link.photo_challenge_required && (!input.challengeId || !UUID.test(input.challengeId))) {
      throw new ApiError(409, 'CHALLENGE_INVALID', 'Falta el código de la foto. Pida uno nuevo y vuelva a tomarla.');
    }

    // --- Transacción: bloquear, revalidar, generar, guardar ---
    const written: string[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ status: LinkRow['status']; expired: boolean }>(
        'SELECT status, (expires_at <= now()) AS expired FROM signature_requests WHERE id = $1 FOR UPDATE',
        [link.id],
      );
      // Revalidar con el estado ya bloqueado: otro envío pudo firmarla mientras tanto.
      this.sign.assertOpen({ ...link, status: locked.rows[0].status, expired: locked.rows[0].expired });

      let otpEvidence: { verifiedAt: Date; attempts: number } | null = null;
      if (link.otp_channel) {
        const { rows } = await client.query<{ consumed_at: Date; attempts: number }>(
          `SELECT consumed_at, attempts FROM otp_challenges
            WHERE request_id = $1 AND consumed_at IS NOT NULL ORDER BY consumed_at DESC LIMIT 1`,
          [link.id],
        );
        if (!rows[0]) throw new ApiError(401, 'SESSION_INVALID', 'Su sesión venció. Vuelva a verificar su código.');
        otpEvidence = { verifiedAt: rows[0].consumed_at, attempts: rows[0].attempts };
      }

      let challenge: { id: string; code: string } | null = null;
      if (link.photo_challenge_required) {
        const { rows } = await client.query<{ id: string; code: string; expired: boolean }>(
          `SELECT id, code, (expires_at <= now()) AS expired FROM photo_challenges
            WHERE request_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL
            ORDER BY issued_at DESC LIMIT 1 FOR UPDATE`,
          [link.id],
        );
        // Un fallo de validación NO consume el código: el firmante puede reintentar con el mismo mientras viva.
        if (!rows[0] || rows[0].id !== input.challengeId) {
          throw new ApiError(409, 'CHALLENGE_INVALID', 'El código de la foto ya no es válido. Pida uno nuevo y vuelva a tomarla.');
        }
        if (rows[0].expired) {
          throw new ApiError(409, 'CHALLENGE_EXPIRED', 'El código de la foto venció. Pida uno nuevo y vuelva a tomarla.');
        }
        challenge = { id: rows[0].id, code: rows[0].code };
      }

      const signedAt = (await client.query<{ now: Date }>('SELECT now()')).rows[0].now;
      const pdf = Buffer.from(
        await renderDocument(link.document_type, {
          reference: link.reference,
          issuer: { legalName: link.legal_name, registryCode: link.registry_code },
          signer: link.snapshot.signer,
          data: link.snapshot.data,
          content: resolveContent(link.document_type, link.body_json),
          annexText: link.annex_text,
          clauseText: link.clause_text,
          form,
          signedAt,
          evidence: {
            ip: toInet(ctx.ip),
            otpVerifiedAt: otpEvidence?.verifiedAt ?? null,
            challengeCode: challenge?.code ?? null,
            photo,
            idPhoto,
            idPhotoBack,
          },
        }),
      );
      const pdfSha = createHash('sha256').update(pdf).digest('hex');

      const base = `${link.tenant_id}/${link.id}`;
      const pdfPath = `${base}/document.bin`;
      const photoPath = photo ? `${base}/photo.bin` : null;
      const idPhotoPath = idPhoto ? `${base}/id-photo.bin` : null;
      const idBackPath = idPhotoBack ? `${base}/id-photo-back.bin` : null;
      await this.storage.put(pdfPath, pdf);
      written.push(pdfPath);
      if (photo && photoPath) {
        await this.storage.put(photoPath, photo.bytes);
        written.push(photoPath);
      }
      if (idPhoto && idPhotoPath) {
        await this.storage.put(idPhotoPath, idPhoto.bytes);
        written.push(idPhotoPath);
      }
      if (idPhotoBack && idBackPath) {
        await this.storage.put(idBackPath, idPhotoBack.bytes);
        written.push(idBackPath);
      }

      const upd = await client.query(
        `UPDATE signature_requests SET status = 'SIGNED', signed_at = $2, pdf_path = $3, pdf_sha256 = $4
          WHERE id = $1 AND status = 'PENDING' RETURNING id`,
        [link.id, signedAt, pdfPath, pdfSha],
      );
      if (!upd.rowCount) throw new ApiError(410, 'ALREADY_SIGNED', 'Este documento ya fue firmado.');

      await client.query(
        `INSERT INTO signature_evidence
           (request_id, otp_verified_at, otp_attempts, challenge_id, photo_received_at, photo_path, photo_sha256,
            photo_width, photo_height, form_json, clause_text, ip, user_agent, client_info, captured_at,
            id_photo_received_at, id_photo_path, id_photo_sha256, id_photo_width, id_photo_height,
            id_back_received_at, id_back_path, id_back_sha256, id_back_width, id_back_height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
        [
          link.id,
          otpEvidence?.verifiedAt ?? null,
          otpEvidence?.attempts ?? 0,
          challenge?.id ?? null,
          photo ? signedAt : null,
          photoPath,
          photo?.sha256 ?? null,
          photo?.width ?? null,
          photo?.height ?? null,
          JSON.stringify(form),
          link.clause_text,
          toInet(ctx.ip),
          ctx.userAgent?.slice(0, 500) ?? '',
          JSON.stringify(clientInfo),
          signedAt,
          idPhoto ? signedAt : null,
          idPhotoPath,
          idPhoto?.sha256 ?? null,
          idPhoto?.width ?? null,
          idPhoto?.height ?? null,
          idPhotoBack ? signedAt : null,
          idBackPath,
          idPhotoBack?.sha256 ?? null,
          idPhotoBack?.width ?? null,
          idPhotoBack?.height ?? null,
        ],
      );
      if (challenge) await client.query('UPDATE photo_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);

      // El aviso al host nace con la firma: si esta transacción se deshace, el aviso tampoco existe.
      await enqueueWebhook(client, link.id, 'signature.signed');

      await client.query('COMMIT');
      await this.sign.log(link.id, 'signed', ctx, { pdfSha256: pdfSha });
      const emailed = link.otp_channel === 'EMAIL' && !!link.otp_to && (await this.mail.isConfigured(link.tenant_id));
      if (emailed) {
        this.trackConfirmation(
          this.sendConfirmation(link, pdf).catch((e) => this.logger.error(`Confirmación de ${link.reference}: ${(e as Error).message}`)),
        );
      }
      return { reference: link.reference, signedAt: signedAt.toISOString(), pdfSha256: pdfSha, emailed };
    } catch (e) {
      await this.rollback(client);
      // Lo que se alcanzó a escribir en disco no quedó referenciado por nada: se borra.
      await Promise.all(written.map((p) => this.storage.remove(p).catch(() => undefined)));
      if (e instanceof StorageNotConfiguredError) {
        throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'El servicio no está listo para firmar. Contacte a su corredor.');
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /** Valida una imagen recibida (JPEG/PNG real, resolución mínima) y calcula su huella. */
  private checkedImage(
    bytes: Buffer,
    prefix: 'PHOTO' | 'ID_PHOTO' | 'ID_PHOTO_BACK',
  ): { bytes: Buffer; type: 'jpeg' | 'png'; width: number; height: number; sha256: string } {
    const info = imageInfo(bytes);
    if (!info) throw new ApiError(422, `${prefix}_INVALID`, 'El archivo no es una imagen JPEG o PNG válida.');
    const tooSmall = checkResolution(info, prefix === 'PHOTO' ? 'selfie' : 'id');
    if (tooSmall) throw new ApiError(422, `${prefix}_TOO_SMALL`, tooSmall);
    return { bytes, type: info.type, width: info.width, height: info.height, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  /** La copia firmada para el firmante (con su sesión, que sigue vigente un rato tras firmar). */
  async signedDocument(token: string, sessionToken: string | undefined): Promise<{ pdf: Buffer; filename: string }> {
    const row = await this.sign.find(token);
    this.sign.assertSession(row, sessionToken);
    if (row.status !== 'SIGNED' || !row.pdf_path) {
      throw new ApiError(409, 'NOT_SIGNED', 'Este documento todavía no está firmado.');
    }
    return { pdf: await this.storage.get(row.pdf_path), filename: `${row.reference}.pdf` };
  }

  /** Copia por correo al firmante. Mejor esfuerzo: la firma ya es válida aunque el correo falle. */
  private async sendConfirmation(link: LinkRow, pdf: Buffer): Promise<void> {
    if (link.otp_channel !== 'EMAIL' || !link.otp_to) return;
    if (!(await this.mail.isConfigured(link.tenant_id))) return;
    try {
      await this.mail.send(link.tenant_id, {
        to: link.otp_to,
        subject: `Su documento firmado ${link.reference}`,
        text:
          `Adjuntamos la copia de su documento ${link.reference}, firmado electrónicamente.\n\n` +
          `Guárdela: es su constancia. Si usted no firmó este documento, comuníquese de inmediato con ${link.legal_name}.`,
        attachments: [{ filename: `${link.reference}.pdf`, content: pdf, contentType: 'application/pdf' }],
      });
      await this.sign.log(link.id, 'confirmation_sent', { ip: null, userAgent: null });
    } catch (e) {
      await this.sign.log(link.id, 'confirmation_failed', { ip: null, userAgent: null }, { reason: (e as Error).message.slice(0, 200) });
      throw e;
    }
  }

  private trackConfirmation(p: Promise<void>): void {
    this.pendingConfirmations.add(p);
    void p.finally(() => this.pendingConfirmations.delete(p));
  }

  /** Apagado ordenado: deja terminar los correos de confirmación que ya salieron a enviarse. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.pendingConfirmations]);
  }

  private async rollback(client: PoolClient): Promise<void> {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}
