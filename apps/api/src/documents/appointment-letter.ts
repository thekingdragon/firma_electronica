import { PdfFlow } from './pdf-flow';
import type { DocumentRenderer, RenderInput } from './types';

/**
 * Textos del modelo de carta de nombramiento (Anexo I). Son los de partida: la plantilla del tenant
 * puede traer los suyos en `content.texts` (otro país, otra redacción); lo que no traiga cae acá.
 */
export const DEFAULT_LETTER_TEXTS = {
  title: 'CARTA DE NOMBRAMIENTO',
  salutation: 'Señores:',
  addressee: 'CORREDORES DE SEGUROS',
  presente: 'Presente.-',
  greeting: 'Estimados señores:',
  body:
    'Les dirijo la presente para hacerles de conocimiento mi decisión de nombrarlos como Corredores de Seguros ' +
    'para efectuar la asesoría e intermediación de los seguros que se señalan a continuación:',
  powersIntro: 'Por lo tanto se encuentran facultados para realizar los siguientes actos en mi representación que implica:',
  observationLabel:
    'Observación: En caso el contratante o asegurado quiera otorgar alguna de las facultades antes mencionadas, debe especificarla:',
  noObservation: '—',
  closing: 'Atentamente,',
  signerBlock: 'Datos de contratante o asegurado',
  annexTitle: 'ANEXO A LA CARTA DE NOMBRAMIENTO',
  evidenceTitle: 'CONSTANCIA DE FIRMA ELECTRÓNICA',
} as const;

type Texts = Record<keyof typeof DEFAULT_LETTER_TEXTS, string>;

interface PowerDef {
  code: string;
  text: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** «A», «B», … «Z»; pasado el alfabeto, números. */
const bullet = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

function formatDate(d: Date): string {
  return d.toLocaleDateString('es-PE', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}

function formatDateTimeUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

export const renderAppointmentLetter: DocumentRenderer = async (input: RenderInput) => {
  const texts: Texts = { ...DEFAULT_LETTER_TEXTS, ...((input.content.texts as Partial<Texts>) ?? {}) };
  const powers = (Array.isArray(input.content.powers) ? input.content.powers : []) as PowerDef[];
  const insurances = Array.isArray(input.data.insurances) ? (input.data.insurances as unknown[]).map(str).filter(Boolean) : [];
  const chosen = new Set(input.form.powers);

  const f = await PdfFlow.create();
  const { doc } = f;
  doc.setTitle(`${texts.title} ${input.reference}`);
  doc.setAuthor(input.issuer.legalName);
  doc.setSubject('Documento firmado electrónicamente');
  doc.setProducer('firma-electronica-service');
  doc.setCreator('firma-electronica-service');
  doc.setCreationDate(input.signedAt);
  doc.setModificationDate(input.signedAt);

  // --- Anexo I: la carta ---
  f.paragraph(input.issuer.legalName, { size: 11, bold: true, after: 1 });
  if (input.issuer.registryCode) f.paragraph(`Código de registro: ${input.issuer.registryCode}`, { size: 9, color: 'muted', after: 10 });
  else f.gap(9);
  f.paragraph(formatDate(input.signedAt), { align: 'right', after: 14 });
  f.paragraph(texts.title, { size: 14, bold: true, align: 'center', after: 16 });

  f.paragraph(texts.salutation, { after: 2 });
  f.paragraph(texts.addressee, { bold: true, after: 1 });
  f.paragraph(input.issuer.legalName, { bold: true, after: 1 });
  f.paragraph(texts.presente, { after: 10 });
  f.paragraph(texts.greeting, { after: 6 });
  f.paragraph(texts.body, { after: 8 });
  insurances.forEach((s, i) => f.paragraph(`${bullet(i)}.  ${s}`, { indent: 18, bold: true, after: 2 }));
  f.gap(8);

  f.paragraph(texts.powersIntro, { after: 6 });
  for (const p of powers) f.checkbox(chosen.has(p.code), str(p.text), { indent: 10 });
  f.gap(6);

  f.paragraph(texts.observationLabel, { after: 3 });
  f.paragraph(input.form.observation.trim() || texts.noObservation, { indent: 10, after: 14 });

  f.need(110);
  f.paragraph(texts.closing, { after: 10 });
  f.paragraph(texts.signerBlock, { bold: true, after: 4 });
  f.field('Nombre:', input.signer.name, { indent: 10 });
  f.field('Documento:', `${input.signer.documentType} ${input.signer.documentNumber}`, { indent: 10 });
  f.gap(6);
  f.paragraph(`Firmado electrónicamente el ${formatDateTimeUtc(input.signedAt)}.`, { size: 9, color: 'muted', after: 4 });
  f.paragraph(input.clauseText, { size: 9, color: 'muted', after: 4 });

  // --- Anexo A: obligaciones del corredor (lo pone el corredor) ---
  if (input.annexText) {
    f.newPage();
    f.paragraph(texts.annexTitle, { size: 12, bold: true, align: 'center', after: 4 });
    f.paragraph('(Elaborado por el corredor de seguros)', { size: 9, color: 'muted', align: 'center', after: 12 });
    for (const block of input.annexText.split(/\n{2,}/)) {
      const [first, ...rest] = block.split('\n');
      const isHeading = rest.length === 0 && first.length < 70 && !/^[a-z]\./i.test(first);
      if (isHeading) f.paragraph(first, { bold: true, size: 10.5, after: 4 });
      else f.paragraph(block.replace(/\n(?=[a-z]\.)/gi, '\n'), { size: 9.5, after: 8 });
    }
    f.gap(6);
    f.paragraph(`Corredor de seguros: ${input.issuer.legalName}`, { bold: true, size: 9.5, after: 1 });
    if (input.issuer.registryCode) f.paragraph(`Código de registro: ${input.issuer.registryCode}`, { size: 9.5 });
  }

  // --- Constancia de la firma electrónica ---
  f.need(220);
  f.rule();
  f.paragraph(texts.evidenceTitle, { size: 11, bold: true, after: 6 });
  f.field('Referencia:', input.reference);
  f.field('Fecha y hora de la firma:', formatDateTimeUtc(input.signedAt));
  if (input.evidence.otpVerifiedAt) f.field('Código de verificación (OTP) validado:', formatDateTimeUtc(input.evidence.otpVerifiedAt));
  f.field('Dirección IP:', input.evidence.ip ?? 'desconocida');
  if (input.evidence.challengeCode) f.field('Código del desafío mostrado en pantalla:', input.evidence.challengeCode);
  if (input.evidence.photo) {
    const ph = input.evidence.photo;
    f.field('Fotografía de verificación:', `${ph.width}×${ph.height} px · SHA-256 ${ph.sha256}`);
    f.gap(4);
    // Copia EXACTA en un Uint8Array propio: pdf-lib lee mal un Buffer de Node que es una porción de un
    // bloque de memoria mayor (como los que entrega multer) y lo rechaza con «SOI not found in JPEG».
    // Fallaba solo a veces, según cómo se asignara la memoria.
    const bytes = new Uint8Array(ph.bytes);
    const img = ph.type === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    f.image(img, 170, 130);
  }
  if (input.evidence.idPhoto) {
    const ip = input.evidence.idPhoto;
    f.field('Fotografía del documento de identidad:', `${ip.width}×${ip.height} px · SHA-256 ${ip.sha256}`);
    f.gap(4);
    const bytes = new Uint8Array(ip.bytes);
    const img = ip.type === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    f.image(img, 170, 130);
  }

  f.footers(`${input.reference}  ·  Documento firmado electrónicamente`);
  return doc.save();
};
