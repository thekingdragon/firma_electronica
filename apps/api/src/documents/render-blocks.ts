import { Block, VariableContext, dataStrings, fillVariables, resolveBlocks } from './blocks';
import { plainText, stripMarks } from './inline';
import { PdfFlow } from './pdf-flow';
import type { DocumentRenderer, RenderInput } from './types';

const EVIDENCE_TITLE = 'CONSTANCIA DE FIRMA ELECTRÓNICA';
const NO_OBSERVATION = '—';

/** «A», «B», … «Z»; pasado el alfabeto, números. */
const letter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

export function formatDate(d: Date): string {
  return d.toLocaleDateString('es-PE', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}

function formatDateTimeUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

/** Las variables de un documento concreto. La fecha es la de la firma. */
export function variableContextOf(input: Pick<RenderInput, 'issuer' | 'signer' | 'reference' | 'signedAt'>): VariableContext {
  return {
    brokerLegalName: input.issuer.legalName,
    brokerRegistryCode: input.issuer.registryCode,
    signerName: input.signer.name,
    signerDocumentType: input.signer.documentType,
    signerDocumentNumber: input.signer.documentNumber,
    reference: input.reference,
    date: formatDate(input.signedAt),
  };
}

/**
 * Generador de PDF a partir de los bloques de la plantilla. Es el MISMO para todos los tipos de documento: lo
 * que cambia de uno a otro es la lista de bloques. La constancia de la firma va siempre al final y no es
 * editable (es lo que prueba la firma; no puede quitarla una plantilla).
 */
export const renderBlocksDocument: DocumentRenderer = async (input: RenderInput) => {
  const blocks = resolveBlocks(input.content, input.annexText);
  const ctx = variableContextOf(input);
  const fill = (s: string) => fillVariables(s, ctx);
  const chosen = new Set(input.form.powers);
  const consented = new Set(input.form.consents ?? []);

  const f = await PdfFlow.create();
  const { doc } = f;
  const firstTitle = blocks.find((b) => b.type === 'title');
  doc.setTitle(`${firstTitle && firstTitle.type === 'title' ? plainText(fill(firstTitle.text)) : 'Documento'} ${input.reference}`);
  doc.setAuthor(input.issuer.legalName);
  doc.setSubject('Documento firmado electrónicamente');
  doc.setProducer('firma-electronica-service');
  doc.setCreator('firma-electronica-service');
  doc.setCreationDate(input.signedAt);
  doc.setModificationDate(input.signedAt);

  const draw = (b: Block): void => {
    switch (b.type) {
      case 'issuerHeader':
        f.paragraph(input.issuer.legalName, { size: 11, bold: true, after: 1 });
        if (b.showRegistry && input.issuer.registryCode) {
          f.paragraph(`Código de registro: ${input.issuer.registryCode}`, { size: 9, color: 'muted', after: b.showDate ? 10 : 12 });
        } else f.gap(b.showDate ? 9 : 6);
        if (b.showDate) f.paragraph(formatDate(input.signedAt), { align: 'right', after: 14 });
        return;
      case 'title':
        f.paragraph(fill(b.text), { size: 14, bold: true, align: 'center', after: 16 });
        return;
      case 'heading':
        f.need(40);
        f.paragraph(fill(b.text), { size: 11, bold: true, after: 4 });
        return;
      case 'paragraph':
        f.paragraph(fill(b.text), { size: b.small ? 9 : 10, bold: b.bold, align: b.align, color: b.small ? 'muted' : 'ink', after: 8 });
        return;
      case 'list':
        b.items.forEach((item, i) => {
          if (b.style === 'check') f.checkbox(true, fill(item), { indent: 10 });
          else f.paragraph(`${b.style === 'letters' ? `${letter(i)}.` : '•'}  ${fill(item)}`, { indent: 18, after: 2 });
        });
        f.gap(8);
        return;
      case 'dataList':
        dataStrings(input.data, b.dataKey).forEach((s, i) =>
          f.paragraph(`${b.style === 'letters' ? `${letter(i)}.` : '•'}  ${s}`, { indent: 18, bold: true, after: 2 }),
        );
        f.gap(8);
        return;
      case 'powers':
        if (b.intro.trim()) f.paragraph(fill(b.intro), { after: 6 });
        for (const p of b.items) f.checkbox(chosen.has(p.code), fill(p.text), { indent: 10 });
        f.gap(6);
        if (b.observation.enabled) {
          f.paragraph(fill(b.observation.label), { after: 3 });
          f.paragraph(input.form.observation.trim() || NO_OBSERVATION, { indent: 10, after: 14 });
        }
        return;
      case 'consent':
        f.checkbox(consented.has(b.code), fill(b.text), { indent: 0, after: 8 });
        return;
      case 'signerBox':
        f.need(90);
        f.paragraph(fill(b.title), { bold: true, after: 4 });
        f.paragraph(`Nombre: **${stripMarks(input.signer.name)}**`, { indent: 10, after: 3 });
        f.paragraph(`Documento: **${stripMarks(input.signer.documentType)} ${stripMarks(input.signer.documentNumber)}**`, { indent: 10, after: 3 });
        f.gap(6);
        return;
      case 'signatureStamp':
        f.paragraph(`Firmado electrónicamente el ${formatDateTimeUtc(input.signedAt)}.`, { size: 9, color: 'muted', after: 4 });
        f.paragraph(input.clauseText, { size: 9, color: 'muted', after: 4 });
        return;
      case 'annex': {
        f.newPage();
        f.paragraph(fill(b.title), { size: 12, bold: true, align: 'center', after: b.subtitle ? 4 : 12 });
        if (b.subtitle) f.paragraph(fill(b.subtitle), { size: 9, color: 'muted', align: 'center', after: 12 });
        for (const part of fill(b.text).split(/\n{2,}/)) {
          const [first, ...rest] = part.split('\n');
          const isHeading = rest.length === 0 && first.length < 70 && !/^[a-z]\./i.test(first);
          if (isHeading) f.paragraph(first, { bold: true, size: 10.5, after: 4 });
          else f.paragraph(part, { size: 9.5, after: 8 });
        }
        f.gap(6);
        f.paragraph(`Corredor de seguros: ${input.issuer.legalName}`, { bold: true, size: 9.5, after: 1 });
        if (input.issuer.registryCode) f.paragraph(`Código de registro: ${input.issuer.registryCode}`, { size: 9.5 });
        return;
      }
      case 'pageBreak':
        f.newPage();
        return;
    }
  };
  for (const b of blocks) draw(b);

  // --- Constancia de la firma electrónica (fija) ---
  f.need(220);
  f.rule();
  f.paragraph(EVIDENCE_TITLE, { size: 11, bold: true, after: 6 });
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

  if (input.evidence.idPhotoBack) {
    const ib = input.evidence.idPhotoBack;
    f.field('Fotografía del reverso del documento de identidad:', `${ib.width}×${ib.height} px · SHA-256 ${ib.sha256}`);
    f.gap(4);
    const bytes = new Uint8Array(ib.bytes);
    const img = ib.type === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    f.image(img, 170, 130);
  }

  f.footers(`${input.reference}  ·  Documento firmado electrónicamente`);
  // Sin flujos de objetos: el sello de integridad (PDF firmado) necesita la tabla de referencias clásica.
  return doc.save({ useObjectStreams: false });
};
