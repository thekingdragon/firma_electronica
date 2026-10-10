/**
 * Sello de integridad de un PDF firmado.
 *
 * El servicio firma el PDF con su propio certificado (PDF firmado, PAdES básico, detached CMS sobre el documento
 * completo): cualquier visor de PDF muestra si el documento fue modificado DESPUÉS de sellarse. Es un sello del
 * SERVICIO —de quien custodia la evidencia—, no la firma del cliente ni una firma digital con certificado de una
 * entidad acreditada: el certificado es autofirmado y su huella se publica en la evidencia para poder compararla.
 *
 * Módulo puro (sin base de datos ni Nest): generar la llave, sellar y verificar.
 */
import signpdf from '@signpdf/signpdf';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import { P12Signer } from '@signpdf/signer-p12';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import forge from 'node-forge';

export interface SealKeyMaterial {
  certificatePem: string;
  privateKeyPem: string;
}

/** Reserva para la firma dentro del PDF (hex): un CMS con un certificado autofirmado cabe de sobra. */
const SIGNATURE_LENGTH = 8192;
/** El P12 solo vive en memoria durante el sellado; la contraseña no protege nada. */
const P12_PASS = 'sello';

export function certificateFingerprint(certificatePem: string): string {
  const der = forge.pem.decode(certificatePem)[0].body;
  return createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex');
}

/** Genera la llave y el certificado autofirmado del servicio (RSA 2048, 10 años). */
export function generateSealKey(subject: { commonName: string; organization: string }): SealKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = randomBytes(16).toString('hex');
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 5 * 60_000);
  cert.validity.notAfter = new Date(now.getTime() + 10 * 365 * 24 * 3600_000);
  const attrs = [
    { name: 'commonName', value: subject.commonName },
    { name: 'organizationName', value: subject.organization },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { certificatePem: forge.pki.certificateToPem(cert), privateKeyPem: privateKey };
}

export interface SealMeta {
  reason: string;
  name: string;
  location: string;
  contactInfo: string;
  signingTime: Date;
}

/** El PDF debe estar guardado SIN flujos de objetos (pdf-lib: \`save({ useObjectStreams: false })\`). */
export async function sealPdf(pdf: Uint8Array, key: SealKeyMaterial, meta: SealMeta): Promise<Buffer> {
  const privateKey = forge.pki.privateKeyFromPem(key.privateKeyPem);
  const cert = forge.pki.certificateFromPem(key.certificatePem);
  const p12 = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(privateKey, [cert], P12_PASS, { algorithm: '3des' })).getBytes();

  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: Buffer.from(pdf),
    reason: meta.reason,
    contactInfo: meta.contactInfo,
    name: meta.name,
    location: meta.location,
    signingTime: meta.signingTime,
    signatureLength: SIGNATURE_LENGTH,
  });
  return signpdf.sign(withPlaceholder, new P12Signer(Buffer.from(p12, 'binary'), { passphrase: P12_PASS }), meta.signingTime);
}

/** Motivo con el que `verifySeal` informa que el PDF no trae sello (lo usa quien necesite distinguirlo de uno inválido). */
export const NO_SEAL_REASON = 'El PDF no tiene sello.';

export interface SealVerification {
  /** El sello existe y su firma cuadra con el contenido firmado. */
  valid: boolean;
  /** La firma cubre TODO el archivo (nada se agregó después del sello). */
  coversWholeFile: boolean;
  /** Huella SHA-256 del certificado que firmó. */
  certificateSha256: string | null;
  reason?: string;
}

/**
 * Verifica el sello de un PDF sin depender de un visor: recalcula el resumen de los bytes firmados y comprueba la firma
 * con la clave pública del certificado incluido. No valida una cadena de confianza (el certificado es autofirmado): lo
 * que prueba es que el contenido es EXACTAMENTE el que se selló. Compara la huella del certificado con la guardada.
 */
export function verifySeal(pdf: Buffer): SealVerification {
  const fail = (reason: string): SealVerification => ({ valid: false, coversWholeFile: false, certificateSha256: null, reason });
  const text = pdf.toString('latin1');
  const br = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  if (!br) return fail(NO_SEAL_REASON);
  const [a, b, c, d] = br.slice(1).map(Number);
  if (a !== 0 || b <= 0 || c <= b || d < 0 || c + d > pdf.length) return fail('El rango firmado no es válido.');
  const coversWholeFile = c + d === pdf.length;
  const hexStart = pdf.indexOf('<', b);
  const hexEnd = pdf.indexOf('>', hexStart);
  if (hexStart < 0 || hexEnd < 0 || hexStart !== b || hexEnd + 1 !== c) return fail('La firma no está donde dice el rango.');
  const contentsHex = pdf.subarray(hexStart + 1, hexEnd).toString('latin1').replace(/0+$/, '');
  if (!contentsHex) return fail('La firma está vacía.');
  const signed = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);

  try {
    const der = Buffer.from(contentsHex.length % 2 ? contentsHex + '0' : contentsHex, 'hex').toString('binary');
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der)) as unknown as {
      certificates: forge.pki.Certificate[];
      rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string; digestAlgorithm: string };
    };
    const cert = p7.certificates[0];
    if (!cert) return fail('El sello no trae certificado.');
    const attrs = p7.rawCapture.authenticatedAttributes;
    // 1) El resumen declarado en la firma es el de los bytes firmados.
    const digestAttr = attrs.find((x) => forge.asn1.derToOid((x.value[0] as forge.asn1.Asn1).value as string) === forge.pki.oids.messageDigest);
    const declared = ((digestAttr?.value[1] as forge.asn1.Asn1).value as forge.asn1.Asn1[])[0].value as string;
    const actual = createHash('sha256').update(signed).digest('binary');
    if (declared !== actual) return { valid: false, coversWholeFile, certificateSha256: certificateFingerprint(forge.pki.certificateToPem(cert)), reason: 'El contenido cambió después del sello.' };
    // 2) La firma sobre los atributos autenticados es de la clave del certificado.
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
    const md = forge.md.sha256.create();
    md.update(forge.asn1.toDer(set).getBytes());
    const ok = (cert.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().getBytes(), p7.rawCapture.signature);
    return {
      valid: ok,
      coversWholeFile,
      certificateSha256: certificateFingerprint(forge.pki.certificateToPem(cert)),
      reason: ok ? undefined : 'La firma del sello no es válida.',
    };
  } catch (e) {
    return fail(`No se pudo leer el sello: ${(e as Error).message}`);
  }
}
