import { Inject, Injectable } from '@nestjs/common';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { ApiError } from '../common/api-error';
import { PG_POOL } from '../db/db.module';
import { imageInfo } from '../documents/image-info';
import { checkIntegrity } from '../seal/integrity';
import { StorageService } from '../storage/storage.service';
import type { Tenant } from '../tenants/tenants.service';
import { RequestActionsService } from './request-actions.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * El «paquete de evidencia» de una firma: un ZIP con todo lo que hace falta para demostrarla ante un tercero, SIN
 * depender de este servicio: el PDF sellado, el certificado con que se selló, el sello de tiempo, la bitácora con su
 * cadena de huellas, lo que se registró de la identidad y las fotos (si todavía no vencieron), más un manifiesto con la
 * huella de cada archivo y las instrucciones para verificarlo por su cuenta.
 */
@Injectable()
export class EvidencePackageService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly storage: StorageService,
    private readonly actions: RequestActionsService,
  ) {}

  async build(tenant: Tenant, id: string): Promise<{ bytes: Buffer; filename: string }> {
    if (!UUID.test(id)) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Solicitud no encontrada.');
    // `evidence` ya responde 404 si no es de este tenant y 409 si todavía no está firmada.
    const evidence = await this.actions.evidence(tenant, id);

    const { rows } = await this.pool.query<{
      pdf_path: string | null;
      pdf_sha256: string | null;
      seal_cert_sha256: string | null;
      tsa_path: string | null;
      tsa_at: Date | null;
      photo_path: string | null;
      id_photo_path: string | null;
      id_back_path: string | null;
    }>(
      `SELECT r.pdf_path, r.pdf_sha256, r.seal_cert_sha256, r.tsa_path, r.tsa_at, e.photo_path, e.id_photo_path, e.id_back_path
         FROM signature_requests r JOIN signature_evidence e ON e.request_id = r.id
        WHERE r.id = $1 AND r.tenant_id = $2`,
      [id, tenant.id],
    );
    const r = rows[0];
    const integrity = await checkIntegrity(this.pool, this.storage, id);

    const log = await this.pool.query(
      `SELECT id, event, at, host(ip) AS ip, user_agent, detail, prev_hash, hash FROM access_log WHERE request_id = $1 ORDER BY id`,
      [id],
    );
    const cert = r.seal_cert_sha256
      ? (await this.pool.query<{ certificate_pem: string }>('SELECT certificate_pem FROM seal_keys WHERE fingerprint_sha256 = $1', [r.seal_cert_sha256])).rows[0]
      : undefined;

    const files: Record<string, Uint8Array> = {};
    const present = async (name: string, path: string | null): Promise<void> => {
      if (!path) return;
      try {
        files[name] = await this.storage.get(path);
      } catch {
        /* el archivo ya no está en disco: la evidencia lo dice (integridad) y el paquete sigue sin él */
      }
    };
    await present('documento-firmado.pdf', r.pdf_path);
    await present('sello-de-tiempo.tsr', r.tsa_path);
    for (const [base, path] of [
      ['fotos/selfie', r.photo_path],
      ['fotos/documento-frente', r.id_photo_path],
      ['fotos/documento-reverso', r.id_back_path],
    ] as const) {
      if (!path) continue;
      try {
        const bytes = await this.storage.get(path);
        files[`${base}.${imageInfo(bytes)?.type === 'png' ? 'png' : 'jpg'}`] = bytes;
      } catch {
        /* igual que arriba */
      }
    }
    if (cert) files['certificado-del-servicio.pem'] = utf8(cert.certificate_pem);

    files['evidencia.json'] = utf8(
      JSON.stringify(
        {
          generadoEl: new Date().toISOString(),
          referencia: evidence.reference,
          estado: evidence.status,
          firmadaEl: evidence.signedAt,
          firmante: evidence.signer,
          pdfSha256: r.pdf_sha256,
          selloDeIntegridad: { certificadoSha256: r.seal_cert_sha256 },
          selloDeTiempo: { horaCertificada: r.tsa_at ? r.tsa_at.toISOString() : null },
          verificacionAlGenerarElPaquete: integrity,
          codigoOtp: evidence.otp,
          fotos: { selfie: evidence.photo, documentoFrente: evidence.idPhoto, documentoReverso: evidence.idPhotoBack },
          codigoDelPapel: evidence.challenge,
          formulario: evidence.form,
          textoDeAceptacion: evidence.clauseText,
          ip: evidence.ip,
          navegador: evidence.userAgent,
          datosDelDispositivo: evidence.clientInfo,
          revisionDeIdentidad: evidence.review,
          bitacora: log.rows.map((l) => ({
            id: Number(l.id),
            evento: l.event,
            hora: (l.at as Date).toISOString(),
            ip: l.ip,
            navegador: l.user_agent,
            detalle: l.detail,
            huellaAnterior: l.prev_hash,
            huella: l.hash,
          })),
        },
        null,
        2,
      ),
    );
    files['LEEME.txt'] = utf8(readme(evidence.reference, r.pdf_sha256, r.seal_cert_sha256, Boolean(files['sello-de-tiempo.tsr'])));
    files['manifiesto.sha256'] = utf8(
      Object.keys(files)
        .sort()
        .map((n) => `${sha(files[n])}  ${n}`)
        .join('\n') + '\n',
    );

    return { bytes: Buffer.from(zipSync(files, { level: 6 })), filename: `${evidence.reference}-evidencia.zip` };
  }
}

function readme(reference: string, pdfSha: string | null, certSha: string | null, hasTsr: boolean): string {
  return `PAQUETE DE EVIDENCIA · ${reference}
==================================================

Este paquete contiene todo lo necesario para comprobar la firma sin depender del servicio que la generó.

CONTENIDO
- documento-firmado.pdf        El documento firmado, sellado por el servicio.
- evidencia.json               Lo que se registró: firmante, código de verificación, formulario, textos aceptados, IP,
                               navegador, revisión de identidad y la bitácora completa con su cadena de huellas.
- certificado-del-servicio.pem Certificado con el que se selló el PDF.
- sello-de-tiempo.tsr          ${hasTsr ? 'Sello de tiempo de una autoridad independiente (RFC 3161) sobre la huella del PDF.' : '(No incluido: esta firma todavía no tiene sello de tiempo.)'}
- fotos/                       Selfie y documento de identidad, si no vencieron por el plazo de retención.
- manifiesto.sha256            Huella SHA-256 de cada archivo de este paquete.

CÓMO VERIFICARLO
1) Integridad del PDF. Su huella debe ser:
     ${pdfSha ?? '(desconocida)'}
   Calcúlela con:  sha256sum documento-firmado.pdf   (Windows: certutil -hashfile documento-firmado.pdf SHA256)

2) Sello del PDF. Ábralo en Adobe Acrobat o cualquier visor de PDF con verificación de firmas: indicará si el documento
   fue modificado DESPUÉS de sellarse. El certificado es del servicio (autofirmado): el visor puede avisar que no es de
   confianza, es lo esperado. Compare su huella SHA-256 con la registrada:
     ${certSha ?? '(desconocida)'}
   Calcúlela con:  openssl x509 -in certificado-del-servicio.pem -outform DER | openssl dgst -sha256

3) Sello de tiempo.${hasTsr ? `
   Muestre la hora que certifica la autoridad:   openssl ts -reply -in sello-de-tiempo.tsr -text
   Compruebe que es de este PDF:                 openssl ts -verify -in sello-de-tiempo.tsr -digest ${pdfSha ?? '<huella>'} -CAfile <raiz-de-la-autoridad.pem>
   (El certificado raíz lo publica la autoridad de sellado.)` : ' No disponible en este paquete.'}

4) Bitácora. Cada evento lleva su huella y la del anterior. La huella de un evento es el SHA-256 (hex) del texto:
     huellaAnterior | idSolicitud | evento | hora UTC (AAAA-MM-DDTHH:MM:SS.microsegundosZ) | ip | navegador | detalle
   (campos separados por «|»; los vacíos van como texto vacío). Si se cambia, borra o intercala un evento, la cadena se rompe.

Qué prueba esto y qué no: prueba que el contenido es el que se selló, cuándo existía (con el sello de tiempo) y que la
bitácora no fue alterada. La identidad del firmante se apoya en lo registrado (código por correo, fotos, revisión).
`;
}
