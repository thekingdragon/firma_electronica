import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { PG_POOL } from '../db/db.module';
import { Tenant } from '../tenants/tenants.service';
import { enqueueWebhook } from '../webhooks/outbox';
import { containsReplacementChar } from './requests.service';
import type { RequestStatus } from './request-status';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const reviewSchema = z
  .object({
    result: z.enum(['VERIFIED', 'REJECTED']),
    // Nombre libre: el panel todavía no tiene usuarios, así que quien revisa se identifica a mano.
    reviewedBy: z.string().trim().min(2).max(100),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export interface EvidenceView {
  requestId: string;
  reference: string;
  status: RequestStatus;
  signedAt: string | null;
  pdfSha256: string | null;
  signer: { name: string; documentType: string; documentNumber: string };
  otp: { verifiedAt: string; attempts: number } | null;
  photo: { width: number; height: number; sha256: string; receivedAt: string | null; deletedAt: string | null } | null;
  challenge: { code: string; issuedAt: string } | null;
  form: unknown;
  clauseText: string;
  ip: string | null;
  userAgent: string | null;
  clientInfo: unknown;
  review: { result: 'VERIFIED' | 'REJECTED'; reviewedBy: string; note: string | null; reviewedAt: string } | null;
  /** Bitácora de la solicitud, de la más antigua a la más nueva. */
  events: { event: string; at: string; ip: string | null }[];
}

@Injectable()
export class RequestActionsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private checkId(id: string): void {
    if (!UUID.test(id)) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Solicitud no encontrada.');
  }

  /**
   * Revoca una solicitud PENDIENTE: el link deja de abrir y, si hay una sesión en curso, también deja
   * de poder firmar. Solo vale mientras está pendiente: una firmada o vencida ya no se toca. La
   * revocación y su aviso al host ocurren en la misma transacción.
   */
  async revoke(tenant: Tenant, id: string): Promise<{ id: string; status: 'REVOKED' }> {
    this.checkId(id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `UPDATE signature_requests SET status = 'REVOKED'
          WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING' RETURNING id`,
        [id, tenant.id],
      );
      if (!rows[0]) {
        const cur = await client.query<{ status: RequestStatus }>(
          'SELECT status FROM signature_requests WHERE id = $1 AND tenant_id = $2',
          [id, tenant.id],
        );
        await client.query('ROLLBACK');
        if (!cur.rows[0]) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Solicitud no encontrada.');
        throw new ApiError(409, 'NOT_PENDING', `Solo se puede revocar una solicitud pendiente (esta está ${cur.rows[0].status}).`, {
          status: cur.rows[0].status,
        });
      }
      await client.query(`INSERT INTO access_log (request_id, event) VALUES ($1, 'revoked')`, [id]);
      await enqueueWebhook(client, id, 'signature.revoked');
      await client.query('COMMIT');
      return { id, status: 'REVOKED' };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Todo lo que quedó registrado de una firma, para que una persona decida si la identidad le convence. */
  async evidence(tenant: Tenant, id: string): Promise<EvidenceView> {
    this.checkId(id);
    const { rows } = await this.pool.query(
      `SELECT r.id, r.reference, r.status, r.signed_at, r.pdf_sha256, r.snapshot,
              e.otp_verified_at, e.otp_attempts, e.photo_width, e.photo_height, e.photo_sha256, e.photo_received_at,
              e.photo_deleted_at, e.photo_path, c.code AS challenge_code, c.issued_at AS challenge_issued_at,
              e.form_json, e.clause_text, e.ip::text AS ip, e.user_agent, e.client_info,
              e.review_result, e.reviewed_by, e.review_note, e.reviewed_at
         FROM signature_requests r
         JOIN signature_evidence e ON e.request_id = r.id
         LEFT JOIN photo_challenges c ON c.id = e.challenge_id
        WHERE r.id = $1 AND r.tenant_id = $2`,
      [id, tenant.id],
    );
    const r = rows[0];
    if (!r) {
      // Puede ser 404 (no existe / otro tenant) o 409 (existe pero aún no está firmada).
      const exists = await this.pool.query('SELECT 1 FROM signature_requests WHERE id = $1 AND tenant_id = $2', [id, tenant.id]);
      if (!exists.rowCount) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Solicitud no encontrada.');
      throw new ApiError(409, 'NOT_SIGNED', 'La solicitud todavía no está firmada: no hay evidencia.');
    }
    const log = await this.pool.query<{ event: string; at: Date; ip: string | null }>(
      'SELECT event, at, ip::text AS ip FROM access_log WHERE request_id = $1 ORDER BY id LIMIT 200',
      [id],
    );
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      requestId: r.id,
      reference: r.reference,
      status: r.status,
      signedAt: iso(r.signed_at),
      pdfSha256: r.pdf_sha256,
      signer: r.snapshot.signer,
      otp: r.otp_verified_at ? { verifiedAt: iso(r.otp_verified_at) as string, attempts: r.otp_attempts } : null,
      photo: r.photo_sha256
        ? { width: r.photo_width, height: r.photo_height, sha256: r.photo_sha256, receivedAt: iso(r.photo_received_at), deletedAt: iso(r.photo_deleted_at) }
        : null,
      challenge: r.challenge_code ? { code: r.challenge_code, issuedAt: iso(r.challenge_issued_at) as string } : null,
      form: r.form_json,
      clauseText: r.clause_text,
      ip: r.ip,
      userAgent: r.user_agent,
      clientInfo: r.client_info,
      review: r.review_result
        ? { result: r.review_result, reviewedBy: r.reviewed_by, note: r.review_note, reviewedAt: iso(r.reviewed_at) as string }
        : null,
      events: log.rows.map((l) => ({ event: l.event, at: l.at.toISOString(), ip: l.ip })),
    };
  }

  /**
   * Dictamen del corredor sobre la evidencia (fase 1: revisión humana). No cambia el estado de la firma;
   * se puede corregir un dictamen anterior y cada cambio queda en la bitácora y se avisa al host.
   */
  async review(tenant: Tenant, id: string, body: unknown): Promise<{ result: 'VERIFIED' | 'REJECTED'; reviewedAt: string }> {
    this.checkId(id);
    if (containsReplacementChar(body)) {
      throw new ApiError(422, 'INVALID_ENCODING', 'El cuerpo contiene caracteres inválidos. Envíe el JSON codificado en UTF-8.');
    }
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'El cuerpo de la petición no es válido.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const { result, reviewedBy, note } = parsed.data;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sr = await client.query<{ status: RequestStatus }>(
        'SELECT status FROM signature_requests WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [id, tenant.id],
      );
      if (!sr.rows[0]) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Solicitud no encontrada.');
      if (sr.rows[0].status !== 'SIGNED') {
        throw new ApiError(409, 'NOT_SIGNED', 'Solo se puede revisar una solicitud ya firmada.');
      }
      const { rows } = await client.query<{ reviewed_at: Date; prev: string | null }>(
        `UPDATE signature_evidence e SET review_result = $2, reviewed_by = $3, review_note = $4, reviewed_at = now()
           FROM (SELECT review_result AS prev FROM signature_evidence WHERE request_id = $1) p
          WHERE e.request_id = $1
        RETURNING e.reviewed_at, p.prev`,
        [id, result, reviewedBy, note || null],
      );
      await client.query(`INSERT INTO access_log (request_id, event, detail) VALUES ($1, 'reviewed', $2)`, [
        id,
        JSON.stringify({ result, reviewedBy, previous: rows[0].prev }),
      ]);
      await enqueueWebhook(client, id, 'signature.reviewed');
      await client.query('COMMIT');
      return { result, reviewedAt: rows[0].reviewed_at.toISOString() };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
