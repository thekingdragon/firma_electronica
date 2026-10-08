import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export const WEBHOOK_EVENTS = ['signature.signed', 'signature.expired', 'signature.revoked', 'signature.reviewed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

type Db = Pick<Pool | PoolClient, 'query'>;

interface Row {
  id: string;
  reference: string;
  document_type: string;
  external_ref: string;
  status: string;
  signed_at: Date | null;
  pdf_sha256: string | null;
  url: string | null;
  has_photo: boolean | null;
  has_id_photo: boolean | null;
  has_id_back: boolean | null;
  review_result: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  reviewed_at: Date | null;
}

/**
 * Registra un evento para entregarlo al host (patrón outbox). Se llama con el MISMO cliente de la
 * transacción que causó el cambio: si esa transacción se deshace, el evento tampoco existe; si se
 * confirma, el evento queda garantizado aunque el servicio se caiga un segundo después.
 *
 * La URL sale de la solicitud (`webhook_url`) o, si no tiene, del tenant. Sin URL no se encola nada.
 * El cuerpo se congela acá: un reintento entrega SIEMPRE lo mismo, no el estado de ese momento.
 * Devuelve el id de la entrega, o `null` si no había a dónde enviar.
 */
export async function enqueueWebhook(db: Db, requestId: string, event: WebhookEvent): Promise<string | null> {
  const { rows } = await db.query<Row>(
    `SELECT r.id, r.reference, r.document_type, r.external_ref, r.status, r.signed_at, r.pdf_sha256,
            COALESCE(r.webhook_url, t.webhook_url) AS url,
            (e.photo_path IS NOT NULL) AS has_photo,
            (e.id_photo_path IS NOT NULL) AS has_id_photo,
            (e.id_back_path IS NOT NULL) AS has_id_back,
            e.review_result, e.reviewed_by, e.review_note, e.reviewed_at
       FROM signature_requests r
       JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN signature_evidence e ON e.request_id = r.id
      WHERE r.id = $1`,
    [requestId],
  );
  const r = rows[0];
  if (!r || !r.url) return null;

  const id = randomUUID();
  const payload = {
    event,
    id,
    occurredAt: new Date().toISOString(),
    data: {
      requestId: r.id,
      reference: r.reference,
      documentType: r.document_type,
      externalRef: r.external_ref,
      status: r.status,
      signedAt: r.signed_at ? r.signed_at.toISOString() : null,
      pdfSha256: r.pdf_sha256,
      // Rutas de la propia API: el host baja los archivos con SU clave. No hay URLs firmadas que filtrar.
      documentPath: r.status === 'SIGNED' ? `/v1/requests/${r.id}/document` : null,
      photoPath: r.has_photo ? `/v1/requests/${r.id}/photo` : null,
      idPhotoPath: r.has_id_photo ? `/v1/requests/${r.id}/id-photo` : null,
      idPhotoBackPath: r.has_id_back ? `/v1/requests/${r.id}/id-photo-back` : null,
      review: r.review_result
        ? { result: r.review_result, reviewedBy: r.reviewed_by, note: r.review_note, reviewedAt: r.reviewed_at?.toISOString() ?? null }
        : null,
    },
  };

  await db.query(
    `INSERT INTO webhook_deliveries (id, request_id, event, url, payload) VALUES ($1, $2, $3, $4, $5)`,
    [id, requestId, event, r.url, JSON.stringify(payload)],
  );
  return id;
}
