/**
 * Sello de tiempo de un tercero (RFC 3161). Se le manda a una autoridad de sellado SOLO la huella SHA-256 del PDF
 * sellado (nunca el documento) y devuelve un token firmado por ella que prueba que esa huella existía en ese momento.
 * Es lo que da una fecha y hora que no depende del reloj del servidor.
 */
import { createHash, randomBytes } from 'node:crypto';
import forge from 'node-forge';

const { asn1 } = forge;
const SHA256_OID = forge.pki.oids.sha256 as string;

export class TsaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TsaError';
  }
}

export interface TimestampToken {
  /** La respuesta completa de la autoridad (TimeStampResp, DER): es lo que se guarda y se entrega. */
  response: Buffer;
  /** Hora que certifica la autoridad dentro del token. */
  genTime: Date;
}

/** TimeStampReq: versión 1, huella SHA-256, nonce y que incluya el certificado de la autoridad. */
export function buildTimestampRequest(sha256Hex: string, nonce = randomBytes(8)): Buffer {
  const imprint = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(SHA256_OID).getBytes()),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''),
    ]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, Buffer.from(sha256Hex, 'hex').toString('binary')),
  ]);
  // El nonce va como entero positivo: si su primer bit es 1 se antepone un 0.
  const n = Buffer.from(nonce);
  const nonceBytes = (n[0] & 0x80 ? Buffer.concat([Buffer.from([0]), n]) : n).toString('binary');
  const req = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, String.fromCharCode(1)),
    imprint,
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, nonceBytes),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)),
  ]);
  return Buffer.from(asn1.toDer(req).getBytes(), 'binary');
}

/**
 * Lee la respuesta de la autoridad: exige que haya concedido el sello y que el token sea de ESTA huella; devuelve la hora
 * que certifica. No valida la cadena de certificados de la autoridad (eso lo hace quien verifique con `openssl ts -verify`
 * y el certificado raíz de la autoridad); sí descarta una respuesta rechazada o de otra huella.
 */
export function parseTimestampResponse(response: Buffer, sha256Hex: string): TimestampToken {
  let root: forge.asn1.Asn1;
  try {
    root = asn1.fromDer(response.toString('binary'));
  } catch {
    throw new TsaError('La respuesta de la autoridad de sellado no es válida.');
  }
  const parts = root.value as forge.asn1.Asn1[];
  const status = (((parts[0]?.value as forge.asn1.Asn1[])?.[0]?.value as string) ?? '\xff').charCodeAt(0);
  if (status !== 0 && status !== 1) throw new TsaError(`La autoridad de sellado rechazó la solicitud (estado ${status}).`);
  const token = parts[1];
  if (!token) throw new TsaError('La respuesta no trae el sello.');
  try {
    // ContentInfo { signedData, [0] SignedData { versión, algoritmos, encapContentInfo { TSTInfo, [0] OCTET STRING } … } }
    const signedData = ((token.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0];
    const encap = (signedData.value as forge.asn1.Asn1[])[2];
    const tstDer = (((encap.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0]).value;
    const tst = asn1.fromDer(tstDer as string);
    const fields = tst.value as forge.asn1.Asn1[];
    const imprint = (((fields[2].value as forge.asn1.Asn1[])[1]).value as string);
    if (Buffer.from(imprint, 'binary').toString('hex') !== sha256Hex.toLowerCase()) {
      throw new TsaError('El sello de tiempo recibido es de otra huella.');
    }
    const genTime = asn1.generalizedTimeToDate(fields[4].value as string);
    return { response, genTime };
  } catch (e) {
    if (e instanceof TsaError) throw e;
    throw new TsaError(`No se pudo leer el sello de tiempo: ${(e as Error).message}`);
  }
}

/** Pide el sello de tiempo de una huella a la autoridad en `url`. */
export async function requestTimestamp(url: string, sha256Hex: string, timeoutMs = 15_000): Promise<TimestampToken> {
  const body = buildTimestampRequest(sha256Hex);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new TsaError(`No se pudo contactar a la autoridad de sellado: ${(e as Error).message}`);
  }
  if (!res.ok) throw new TsaError(`La autoridad de sellado respondió ${res.status}.`);
  return parseTimestampResponse(Buffer.from(await res.arrayBuffer()), sha256Hex);
}

/** Huella SHA-256 (hex) de unos bytes. */
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
