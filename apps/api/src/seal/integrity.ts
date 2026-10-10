/**
 * Comprobación de integridad de una firma, de punta a punta, SIN fiarse de lo que dice la aplicación: vuelve a leer el
 * PDF del disco, recalcula su huella, verifica su sello, valida el sello de tiempo (si lo hay) y recorre la cadena de la
 * bitácora. La usan el panel (resumen), el paquete de evidencia y el comando `evidence:verify`.
 */
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { StorageService } from '../storage/storage.service';
import { NO_SEAL_REASON, verifySeal } from './seal';
import { TsaError, parseTimestampResponse } from './tsa';

export interface IntegrityReport {
  requestId: string;
  reference: string;
  /** El PDF se pudo leer y su huella es la registrada. */
  pdfIntact: boolean;
  seal: { present: boolean; valid: boolean; coversWholeFile: boolean; certificateSha256: string | null; matchesRecord: boolean };
  /** El sello de tiempo de la autoridad: `at` es la hora que ella certifica. */
  timestamp: { present: boolean; valid: boolean; at: string | null };
  chain: { ok: boolean; events: number; head: string | null; brokenAt: number | null };
  /** Todo lo OBLIGATORIO cuadra (PDF, sello, bitácora). El sello de tiempo es opcional: si falta, no lo invalida. */
  ok: boolean;
  problems: string[];
}

const NO_SEAL = NO_SEAL_REASON;

interface Row {
  id: string;
  reference: string;
  pdf_path: string | null;
  pdf_sha256: string | null;
  seal_cert_sha256: string | null;
  tsa_path: string | null;
  tsa_at: Date | null;
}

export async function checkIntegrity(pool: Pool, storage: StorageService, requestId: string): Promise<IntegrityReport> {
  const { rows } = await pool.query<Row>(
    "SELECT id, reference, pdf_path, pdf_sha256, seal_cert_sha256, tsa_path, tsa_at FROM signature_requests WHERE id = $1 AND status = 'SIGNED'",
    [requestId],
  );
  const r = rows[0];
  if (!r) throw new Error(`La solicitud ${requestId} no existe o no está firmada.`);
  const problems: string[] = [];
  const report: IntegrityReport = {
    requestId: r.id,
    reference: r.reference,
    pdfIntact: false,
    seal: { present: false, valid: false, coversWholeFile: false, certificateSha256: null, matchesRecord: false },
    timestamp: { present: false, valid: false, at: null },
    chain: { ok: false, events: 0, head: null, brokenAt: null },
    ok: false,
    problems,
  };

  // 1) El PDF y su huella.
  let pdf: Buffer | null = null;
  if (!r.pdf_path) problems.push('La solicitud no tiene PDF guardado.');
  else {
    try {
      pdf = await storage.get(r.pdf_path);
    } catch (e) {
      problems.push(`No se pudo leer el PDF: ${(e as Error).message}`);
    }
  }
  if (pdf) {
    report.pdfIntact = createHash('sha256').update(pdf).digest('hex') === r.pdf_sha256;
    if (!report.pdfIntact) problems.push('La huella del PDF guardado NO coincide con la registrada: el archivo cambió.');
    // 2) El sello de integridad.
    const v = verifySeal(pdf);
    report.seal = {
      present: v.reason !== NO_SEAL,
      valid: v.valid,
      coversWholeFile: v.coversWholeFile,
      certificateSha256: v.certificateSha256,
      matchesRecord: v.certificateSha256 !== null && v.certificateSha256 === r.seal_cert_sha256,
    };
    if (v.reason === NO_SEAL) problems.push('Esta firma es anterior al sello de integridad: su PDF no está sellado.');
    else if (!v.valid) problems.push(`El sello del PDF no es válido: ${v.reason ?? 'sin detalle'}.`);
    else if (!v.coversWholeFile) problems.push('El PDF tiene contenido agregado después del sello.');
    if (v.valid && !report.seal.matchesRecord) problems.push('El certificado del sello no es el registrado para esta firma.');
  }

  // 3) El sello de tiempo (opcional).
  if (r.tsa_path && r.pdf_sha256) {
    report.timestamp.present = true;
    try {
      const token = parseTimestampResponse(await storage.get(r.tsa_path), r.pdf_sha256);
      report.timestamp.valid = true;
      report.timestamp.at = token.genTime.toISOString();
    } catch (e) {
      report.timestamp.at = r.tsa_at ? r.tsa_at.toISOString() : null;
      problems.push(`El sello de tiempo no corresponde al PDF: ${e instanceof TsaError ? e.message : (e as Error).message}`);
    }
  }

  // 4) La cadena de la bitácora.
  const chain = await pool.query<{ ok: boolean; broken_at: string | null; head: string | null; events: number }>(
    'SELECT ok, broken_at, head, events FROM access_log_verify($1)',
    [requestId],
  );
  const c = chain.rows[0];
  report.chain = { ok: c.ok, events: c.events, head: c.head, brokenAt: c.broken_at === null ? null : Number(c.broken_at) };
  if (!c.ok) problems.push(`La bitácora está alterada a partir del evento ${c.broken_at}.`);

  report.ok = report.pdfIntact && report.seal.valid && report.seal.coversWholeFile && report.seal.matchesRecord && report.chain.ok;
  return report;
}
