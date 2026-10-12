/**
 * Plantillas de la carta de nombramiento guardadas ANTES de existir los bloques (textos sueltos + facultades + un anexo).
 * Se leen como los bloques equivalentes: así no hay que migrar filas ni rehacer lo que ya estaba publicado.
 */
import type { Block } from '../../documents/blocks';
import { DEFAULT_LETTER_TEXTS } from './texts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Los bloques equivalentes a una plantilla anterior a los bloques. */
export function blocksFromLegacy(content: Record<string, unknown>, annexText: string | null): Block[] {
  const t = { ...DEFAULT_LETTER_TEXTS, ...((content.texts as Record<string, string> | undefined) ?? {}) };
  const rawPowers = Array.isArray(content.powers) ? (content.powers as Array<Record<string, unknown>>) : [];
  const maxLength = Number((content.observation as { maxLength?: number } | undefined)?.maxLength ?? 1000);

  const blocks: Block[] = [
    { id: 'encabezado', type: 'issuerHeader', showRegistry: true, showDate: true },
    { id: 'titulo', type: 'title', text: t.title },
    {
      id: 'destinatario',
      type: 'paragraph',
      text: [t.salutation, t.addressee, '{{broker.legalName}}', t.presente].join('\n'),
      align: 'left',
      bold: false,
      small: false,
    },
    { id: 'saludo', type: 'paragraph', text: t.greeting, align: 'left', bold: false, small: false },
    { id: 'cuerpo', type: 'paragraph', text: t.body, align: 'left', bold: false, small: false },
    { id: 'seguros', type: 'dataList', dataKey: 'insurances', style: 'letters' },
    {
      id: 'facultades',
      type: 'powers',
      intro: t.powersIntro,
      items: rawPowers.map((p) => ({ code: str(p.code), text: str(p.text), defaultChecked: p.defaultChecked !== false })),
      observation: { enabled: true, label: t.observationLabel, maxLength: Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 1000 },
    },
    { id: 'cierre', type: 'paragraph', text: t.closing, align: 'left', bold: false, small: false },
    { id: 'firmante', type: 'signerBox', title: t.signerBlock },
    { id: 'sello', type: 'signatureStamp' },
  ];
  if (annexText) {
    blocks.push({ id: 'anexo', type: 'annex', title: t.annexTitle, subtitle: '(Elaborado por el corredor de seguros)', text: annexText });
  }
  return blocks;
}
