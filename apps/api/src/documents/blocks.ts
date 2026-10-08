/**
 * Modelo de bloques de un documento.
 *
 * Una plantilla es una LISTA ORDENADA de bloques que cada corredora arma y edita desde el panel (la carta de
 * nombramiento de una corredora no se parece a la de otra: cambian el encabezado, los ramos, las facultades,
 * los consentimientos, los anexos). Este módulo es el único sitio que sabe qué bloques existen, cómo se
 * validan y cómo se completan sus variables; lo usan el generador del PDF, la página de firma y el panel.
 *
 * Todo es texto plano: nada de HTML. Lo que llega del panel se valida acá antes de guardarse, y se vuelve a
 * validar al leerse (una fila vieja o tocada a mano no puede romper la firma).
 */
import { z } from 'zod';
import { DEFAULT_LETTER_TEXTS } from './appointment-letter-texts';

// ---------------------------------------------------------------------------------------------------------
// Variables: lo único que un texto puede interpolar. Cualquier otra cosa es un error al publicar.
// ---------------------------------------------------------------------------------------------------------

export const VARIABLES = [
  { name: 'broker.legalName', label: 'Razón social de la corredora' },
  { name: 'broker.registryCode', label: 'Código de registro de la corredora' },
  { name: 'signer.name', label: 'Nombre del firmante' },
  { name: 'signer.documentType', label: 'Tipo de documento del firmante (DNI…)' },
  { name: 'signer.documentNumber', label: 'Número de documento del firmante' },
  { name: 'reference', label: 'Referencia del documento' },
  { name: 'date', label: 'Fecha (la de la firma)' },
] as const;

const VARIABLE_NAMES: ReadonlySet<string> = new Set(VARIABLES.map((v) => v.name));
const VARIABLE_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;

export interface VariableContext {
  brokerLegalName: string;
  brokerRegistryCode: string | null;
  signerName: string;
  signerDocumentType: string;
  signerDocumentNumber: string;
  reference: string;
  date: string;
}

/** Reemplaza las variables conocidas; las desconocidas quedan tal cual (la validación ya las rechazó al publicar). */
export function fillVariables(text: string, ctx: VariableContext): string {
  const values: Record<string, string> = {
    'broker.legalName': ctx.brokerLegalName,
    'broker.registryCode': ctx.brokerRegistryCode ?? '',
    'signer.name': ctx.signerName,
    'signer.documentType': ctx.signerDocumentType,
    'signer.documentNumber': ctx.signerDocumentNumber,
    reference: ctx.reference,
    date: ctx.date,
  };
  return text.replace(VARIABLE_RE, (whole, name: string) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole));
}

/** Variables que usa un texto y que no existen. */
export function unknownVariables(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VARIABLE_RE)) if (!VARIABLE_NAMES.has(m[1])) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Bloques
// ---------------------------------------------------------------------------------------------------------

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Identificador inválido');
const line = z.string().max(300);
const text = z.string().max(5000);

const issuerHeader = z.object({ id, type: z.literal('issuerHeader'), showRegistry: z.boolean(), showDate: z.boolean() }).strict();
const title = z.object({ id, type: z.literal('title'), text: line }).strict();
const heading = z.object({ id, type: z.literal('heading'), text: line }).strict();
const paragraph = z
  .object({
    id,
    type: z.literal('paragraph'),
    text,
    align: z.enum(['left', 'center', 'right']).default('left'),
    bold: z.boolean().default(false),
    small: z.boolean().default(false),
  })
  .strict();
const list = z
  .object({
    id,
    type: z.literal('list'),
    items: z.array(z.string().min(1).max(1000)).min(1).max(60),
    style: z.enum(['check', 'bullet', 'letters']),
  })
  .strict();
const dataList = z
  .object({
    id,
    type: z.literal('dataList'),
    dataKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/, 'Nombre de dato inválido'),
    style: z.enum(['letters', 'bullet']),
  })
  .strict();
const powerItem = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/, 'El código va en mayúsculas, sin espacios (por ejemplo RENOVACIONES)'),
    text: z.string().min(1).max(1000),
    defaultChecked: z.boolean().default(true),
  })
  .strict();
const powers = z
  .object({
    id,
    type: z.literal('powers'),
    intro: text,
    items: z.array(powerItem).max(40),
    observation: z
      .object({ enabled: z.boolean(), label: z.string().max(1000), maxLength: z.number().int().min(1).max(5000) })
      .strict(),
  })
  .strict();
const signerBox = z.object({ id, type: z.literal('signerBox'), title: line }).strict();
const signatureStamp = z.object({ id, type: z.literal('signatureStamp') }).strict();
const annex = z
  .object({ id, type: z.literal('annex'), title: line, subtitle: line.default(''), text: z.string().min(1).max(20_000) })
  .strict();
const pageBreak = z.object({ id, type: z.literal('pageBreak') }).strict();

export const blockSchema = z.discriminatedUnion('type', [
  issuerHeader,
  title,
  heading,
  paragraph,
  list,
  dataList,
  powers,
  signerBox,
  signatureStamp,
  annex,
  pageBreak,
]);

export type Block = z.infer<typeof blockSchema>;
export type PowersBlock = Extract<Block, { type: 'powers' }>;
export type BlockType = Block['type'];

export const BLOCK_TYPES: readonly BlockType[] = [
  'issuerHeader',
  'title',
  'heading',
  'paragraph',
  'list',
  'dataList',
  'powers',
  'signerBox',
  'signatureStamp',
  'annex',
  'pageBreak',
];

const MAX_BLOCKS = 80;
const MAX_TOTAL_CHARS = 90_000; // por debajo del límite de 100 kB del cuerpo JSON
/** Bloques de los que solo puede haber uno: el formulario y la firma son únicos por documento. */
const SINGLE: readonly BlockType[] = ['powers', 'signatureStamp', 'issuerHeader', 'signerBox'];

export interface BlockIssue {
  path: string;
  message: string;
}

export class BlocksError extends Error {
  constructor(readonly issues: BlockIssue[]) {
    super(issues.map((i) => `${i.path ? i.path + ': ' : ''}${i.message}`).join(' · '));
    this.name = 'BlocksError';
  }
}

/** Todos los textos de un bloque (para revisar variables y tamaño). */
export function textsOf(b: Block): string[] {
  switch (b.type) {
    case 'title':
    case 'heading':
      return [b.text];
    case 'paragraph':
      return [b.text];
    case 'list':
      return b.items;
    case 'powers':
      return [b.intro, b.observation.label, ...b.items.map((i) => i.text)];
    case 'signerBox':
      return [b.title];
    case 'annex':
      return [b.title, b.subtitle, b.text];
    default:
      return [];
  }
}

/**
 * Valida lo que llega (del panel o de la base). Lanza `BlocksError` con TODOS los problemas, cada uno con
 * el lugar donde está («bloque 3», «bloque 5 › ítem 2»).
 */
export function parseBlocks(input: unknown): Block[] {
  if (!Array.isArray(input)) throw new BlocksError([{ path: '', message: 'Los bloques deben ser una lista.' }]);
  if (input.length === 0) throw new BlocksError([{ path: '', message: 'El documento necesita al menos un bloque.' }]);
  if (input.length > MAX_BLOCKS) throw new BlocksError([{ path: '', message: `Hay demasiados bloques (máximo ${MAX_BLOCKS}).` }]);

  const issues: BlockIssue[] = [];
  const blocks: Block[] = [];
  input.forEach((raw, i) => {
    const r = blockSchema.safeParse(raw);
    if (!r.success) {
      for (const is of r.error.issues) {
        const where = `bloque ${i + 1}${is.path.length ? ' › ' + is.path.map((p) => (typeof p === 'number' ? p + 1 : p)).join(' › ') : ''}`;
        issues.push({ path: where, message: is.message });
      }
      return;
    }
    blocks.push(r.data);
  });
  if (issues.length) throw new BlocksError(issues);

  const ids = new Set<string>();
  let chars = 0;
  blocks.forEach((b, i) => {
    if (ids.has(b.id)) issues.push({ path: `bloque ${i + 1}`, message: `El identificador «${b.id}» está repetido.` });
    ids.add(b.id);
    for (const t of textsOf(b)) {
      chars += t.length;
      for (const v of unknownVariables(t)) {
        issues.push({ path: `bloque ${i + 1}`, message: `La variable {{${v}}} no existe. Disponibles: ${VARIABLES.map((x) => `{{${x.name}}}`).join(', ')}.` });
      }
    }
    if (b.type === 'powers') {
      const codes = new Set<string>();
      b.items.forEach((it, j) => {
        if (codes.has(it.code)) issues.push({ path: `bloque ${i + 1} › ítem ${j + 1}`, message: `El código «${it.code}» está repetido.` });
        codes.add(it.code);
      });
    }
  });
  for (const t of SINGLE) {
    if (blocks.filter((b) => b.type === t).length > 1) issues.push({ path: '', message: `Solo puede haber un bloque de tipo «${t}».` });
  }
  if (chars > MAX_TOTAL_CHARS) issues.push({ path: '', message: 'El documento es demasiado largo.' });
  if (issues.length) throw new BlocksError(issues);
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------
// Plantillas anteriores a los bloques
// ---------------------------------------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Una plantilla guardada antes de existir los bloques (textos sueltos + facultades + un anexo) se lee como
 * los bloques equivalentes: así no hay que migrar filas ni rehacer lo que ya estaba publicado.
 */
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

/**
 * Los bloques de una plantilla: los propios si los tiene, y si no, los que salen de su forma anterior.
 * Una plantilla con bloques inválidos no se firma (mejor un error claro que un documento a medias).
 */
export function resolveBlocks(content: Record<string, unknown>, annexText: string | null): Block[] {
  if (content.blocks !== undefined) return parseBlocks(content.blocks);
  return blocksFromLegacy(content, annexText);
}

// ---------------------------------------------------------------------------------------------------------
// Lo que ve el firmante
// ---------------------------------------------------------------------------------------------------------

/** El bloque ya con las variables completas y las listas de datos resueltas: la página de firma solo lo dibuja. */
export type ViewBlock =
  | { id: string; type: 'issuerHeader'; legalName: string; registryCode: string | null; date: string | null }
  | { id: string; type: 'title'; text: string }
  | { id: string; type: 'heading'; text: string }
  | { id: string; type: 'paragraph'; text: string; align: 'left' | 'center' | 'right'; bold: boolean; small: boolean }
  | { id: string; type: 'list'; items: string[]; style: 'check' | 'bullet' | 'letters' }
  | {
      id: string;
      type: 'powers';
      intro: string;
      items: Array<{ code: string; text: string; defaultChecked: boolean }>;
      observation: { enabled: boolean; label: string; maxLength: number };
    }
  | { id: string; type: 'signerBox'; title: string; name: string; document: string }
  | { id: string; type: 'signatureStamp' }
  | { id: string; type: 'annex'; title: string; subtitle: string; text: string }
  | { id: string; type: 'pageBreak' };

export function dataStrings(data: Record<string, unknown>, key: string): string[] {
  const v = data[key];
  return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
}

export function toViewBlocks(blocks: Block[], ctx: VariableContext, data: Record<string, unknown>): ViewBlock[] {
  const f = (s: string) => fillVariables(s, ctx);
  return blocks.map((b): ViewBlock => {
    switch (b.type) {
      case 'issuerHeader':
        return { id: b.id, type: b.type, legalName: ctx.brokerLegalName, registryCode: b.showRegistry ? ctx.brokerRegistryCode : null, date: b.showDate ? ctx.date : null };
      case 'title':
      case 'heading':
        return { id: b.id, type: b.type, text: f(b.text) };
      case 'paragraph':
        return { id: b.id, type: b.type, text: f(b.text), align: b.align, bold: b.bold, small: b.small };
      case 'list':
        return { id: b.id, type: b.type, items: b.items.map(f), style: b.style };
      case 'dataList':
        return { id: b.id, type: 'list', items: dataStrings(data, b.dataKey), style: b.style === 'bullet' ? 'bullet' : 'letters' };
      case 'powers':
        return {
          id: b.id,
          type: b.type,
          intro: f(b.intro),
          items: b.items.map((i) => ({ code: i.code, text: f(i.text), defaultChecked: i.defaultChecked })),
          observation: { ...b.observation, label: f(b.observation.label) },
        };
      case 'signerBox':
        return { id: b.id, type: b.type, title: f(b.title), name: ctx.signerName, document: `${ctx.signerDocumentType} ${ctx.signerDocumentNumber}` };
      case 'signatureStamp':
        return { id: b.id, type: b.type };
      case 'annex':
        return { id: b.id, type: b.type, title: f(b.title), subtitle: f(b.subtitle), text: f(b.text) };
      case 'pageBreak':
        return { id: b.id, type: b.type };
    }
  });
}

/** El bloque de facultades de la plantilla (como mucho uno). */
export function powersBlockOf(blocks: Block[]): PowersBlock | null {
  return (blocks.find((b) => b.type === 'powers') as PowersBlock | undefined) ?? null;
}
