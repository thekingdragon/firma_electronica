import { PDFDocument, StandardFonts } from 'pdf-lib';
import { fakeTimestampResponse } from '../test-utils';
import { SealKeyMaterial, certificateFingerprint, generateSealKey, sealPdf, verifySeal } from './seal';
import { TsaError, buildTimestampRequest, parseTimestampResponse, sha256Hex } from './tsa';
import { dueAfterSeconds } from './seal.service';
import forge from 'node-forge';

const META = { reason: 'prueba', name: 'servicio', location: 'aquí', contactInfo: 'R-1', signingTime: new Date('2026-01-01T00:00:00Z') };

async function pdfWithText(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  page.drawText(text, { size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save({ useObjectStreams: false });
}

describe('sello de integridad del PDF', () => {
  let key: SealKeyMaterial;
  let sealed: Buffer;

  beforeAll(async () => {
    key = generateSealKey({ commonName: 'Prueba', organization: 'Test' });
    sealed = await sealPdf(await pdfWithText('Documento firmado'), key, META);
  }, 30_000);

  it('el certificado es autofirmado, vigente 10 años y su huella es estable', () => {
    const cert = forge.pki.certificateFromPem(key.certificatePem);
    expect(cert.subject.getField('CN').value).toBe('Prueba');
    expect(cert.issuer.getField('CN').value).toBe('Prueba');
    const years = (cert.validity.notAfter.getTime() - cert.validity.notBefore.getTime()) / (365 * 24 * 3600_000);
    expect(years).toBeGreaterThan(9.9);
    expect(certificateFingerprint(key.certificatePem)).toBe(certificateFingerprint(key.certificatePem));
    expect(certificateFingerprint(key.certificatePem)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dos llaves generadas son distintas', () => {
    const otra = generateSealKey({ commonName: 'Prueba', organization: 'Test' });
    expect(certificateFingerprint(otra.certificatePem)).not.toBe(certificateFingerprint(key.certificatePem));
  });

  it('un PDF sellado verifica: firma válida, cubre todo el archivo y la huella del certificado es la de la llave', () => {
    const v = verifySeal(sealed);
    expect(v).toMatchObject({ valid: true, coversWholeFile: true, certificateSha256: certificateFingerprint(key.certificatePem) });
    expect(v.reason).toBeUndefined();
  });

  it('sigue siendo un PDF que se puede abrir y leer', async () => {
    const doc = await PDFDocument.load(sealed);
    expect(doc.getPageCount()).toBe(1);
  });

  it('cambiar UN byte del contenido firmado lo invalida', () => {
    // Se busca una zona dentro del rango firmado: el texto de la página, cerca del principio del archivo.
    for (const pos of [60, 200, 400, sealed.indexOf(Buffer.from('/Contents')) - 30]) {
      const t = Buffer.from(sealed);
      t[pos] = t[pos] ^ 0x01;
      const v = verifySeal(t);
      expect(v.valid).toBe(false);
    }
  });

  it('quitar o cambiar la propia firma lo invalida', () => {
    const t = Buffer.from(sealed);
    const at = t.indexOf(Buffer.from('/Contents')) + 20;
    t[at] = t[at] === 0x41 ? 0x42 : 0x41; // un dígito hexadecimal de la firma
    expect(verifySeal(t).valid).toBe(false);
  });

  it('agregar contenido DESPUÉS del sello se detecta (la firma ya no cubre todo el archivo)', () => {
    const v = verifySeal(Buffer.concat([sealed, Buffer.from('\n%%EOF\nagregado\n')]));
    expect(v.coversWholeFile).toBe(false);
  });

  it('un PDF sin sello se dice sin sello; un archivo cualquiera, también', async () => {
    expect(verifySeal(Buffer.from(await pdfWithText('sin sello')))).toMatchObject({ valid: false, reason: 'El PDF no tiene sello.' });
    expect(verifySeal(Buffer.from('no soy un pdf')).valid).toBe(false);
  });

  it('sellar el mismo PDF con otra llave da otra huella de certificado, y ambos verifican', async () => {
    const otra = generateSealKey({ commonName: 'Otra', organization: 'Test' });
    const s2 = await sealPdf(await pdfWithText('Documento firmado'), otra, META);
    expect(verifySeal(s2).valid).toBe(true);
    expect(verifySeal(s2).certificateSha256).not.toBe(verifySeal(sealed).certificateSha256);
  }, 30_000);

  it('el sello conserva el motivo y el momento de la firma', () => {
    const text = sealed.toString('latin1');
    expect(text).toContain('/Reason');
    expect(text).toMatch(/\/M\s*\(D:20260101000000/);
  });
});

describe('sello de tiempo (RFC 3161)', () => {
  const hash = sha256Hex(Buffer.from('un pdf'));

  it('la solicitud lleva la versión, la huella SHA-256 y pide el certificado de la autoridad', () => {
    const req = forge.asn1.fromDer(buildTimestampRequest(hash).toString('binary'));
    const f = req.value as forge.asn1.Asn1[];
    expect(f[0].value).toBe(String.fromCharCode(1));
    const imprint = f[1].value as forge.asn1.Asn1[];
    expect(forge.asn1.derToOid((imprint[0].value as forge.asn1.Asn1[])[0].value as string)).toBe(forge.pki.oids.sha256);
    expect(Buffer.from(imprint[1].value as string, 'binary').toString('hex')).toBe(hash);
    expect(f[3].value).toBe(String.fromCharCode(0xff)); // certReq = TRUE
  });

  it('dos solicitudes de la misma huella llevan nonce distinto', () => {
    expect(buildTimestampRequest(hash).equals(buildTimestampRequest(hash))).toBe(false);
  });

  it('lee la respuesta concedida: la hora certificada y la huella', () => {
    const t = new Date('2026-10-10T16:46:14Z');
    const parsed = parseTimestampResponse(fakeTimestampResponse(hash, t), hash);
    expect(parsed.genTime.toISOString()).toBe('2026-10-10T16:46:14.000Z');
  });

  it('rechaza un sello que es de OTRA huella', () => {
    expect(() => parseTimestampResponse(fakeTimestampResponse(sha256Hex(Buffer.from('otro')), new Date()), hash)).toThrow(/otra huella/);
  });

  it('rechaza lo que no es una respuesta válida', () => {
    expect(() => parseTimestampResponse(Buffer.from('basura'), hash)).toThrow(TsaError);
  });

  it('la espera para reintentar crece con los intentos: 30 s, 2 min y medio, luego de a poco más', () => {
    expect([0, 1, 2, 3].map(dueAfterSeconds)).toEqual([0, 30, 150, 750]);
    expect(dueAfterSeconds(7)).toBeGreaterThan(dueAfterSeconds(6));
  });
});
