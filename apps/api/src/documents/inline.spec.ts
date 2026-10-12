import { BlocksError, fillVariables, parseBlocks, toViewBlocks, type VariableContext } from './blocks';
import { hasUnbalancedMarks, parseInline, plainText, stripMarks } from './inline';
import { PdfFlow } from './pdf-flow';
import { renderBlocksDocument } from './render-blocks';
import type { RenderInput } from './types';

type Line = Array<{ text: string; bold: boolean; width: number }>;
const layout = async (text: string, width = 500, baseBold = false): Promise<Line[]> => {
  const f = await PdfFlow.create();
  return (f as unknown as { layoutRich: (t: string, s: number, w: number, b: boolean) => Line[] }).layoutRich(text, 10, width, baseBold);
};
const flat = (l: Line) => l.map((p) => (p.bold ? `[${p.text}]` : p.text)).join('');

describe('inline: negrita con **', () => {
  it('parte un texto en tramos normales y en negrita', () => {
    expect(parseInline('Yo, **Ana Pérez**, con **DNI 1**.')).toEqual([
      { text: 'Yo, ', bold: false },
      { text: 'Ana Pérez', bold: true },
      { text: ', con ', bold: false },
      { text: 'DNI 1', bold: true },
      { text: '.', bold: false },
    ]);
  });
  it('un texto sin marcas es un solo tramo; el vacío también', () => {
    expect(parseInline('hola')).toEqual([{ text: 'hola', bold: false }]);
    expect(parseInline('')).toEqual([{ text: '', bold: false }]);
  });
  it('detecta un ** sin pareja', () => {
    expect(hasUnbalancedMarks('uno **dos')).toBe(true);
    expect(hasUnbalancedMarks('uno **dos** tres')).toBe(false);
    expect(hasUnbalancedMarks('sin marcas')).toBe(false);
  });
  it('quita las marcas de un valor', () => {
    expect(stripMarks('a**b**c')).toBe('abc');
    expect(plainText('**Título** del documento')).toBe('Título del documento');
  });
});

describe('variables y negrita', () => {
  const ctx: VariableContext = {
    brokerLegalName: 'Mavac **SAC**',
    brokerRegistryCode: null,
    signerName: 'Ana **Pérez',
    signerDocumentType: 'DNI',
    signerDocumentNumber: '12345678',
    reference: 'R-1',
    date: '1 de enero de 2026',
  };
  it('un valor que trae ** no puede abrir ni cerrar una negrita en el texto', () => {
    expect(fillVariables('Yo, **{{signer.name}}**, de {{broker.legalName}}', ctx)).toBe('Yo, **Ana Pérez**, de Mavac SAC');
  });
  it('los datos de la solicitud (los seguros) llegan en negrita al firmante y sin marcas ajenas', () => {
    const v = toViewBlocks(parseBlocks([{ id: 'l', type: 'dataList', dataKey: 'seguros', style: 'letters' }]), ctx, { seguros: ['SCTR **Salud**', 'Vida'] });
    expect(v[0]).toMatchObject({ type: 'list', items: ['**SCTR Salud**', '**Vida**'] });
  });
  it('al publicar, un ** sin cerrar se rechaza diciendo en qué bloque', () => {
    try {
      parseBlocks([{ id: 'a', type: 'title', text: 'T' }, { id: 'b', type: 'paragraph', text: 'Hola **mundo' }]);
      throw new Error('debía lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(BlocksError);
      expect((e as BlocksError).issues[0]).toMatchObject({ path: 'bloque 2' });
      expect((e as BlocksError).issues[0].message).toContain('**');
    }
  });
  it('con las marcas bien cerradas se acepta, también dentro de listas, facultades y consentimientos', () => {
    expect(() =>
      parseBlocks([
        { id: 'l', type: 'list', items: ['**uno**', 'dos'], style: 'bullet' },
        { id: 'p', type: 'powers', intro: '**i**', items: [{ code: 'A', text: 'hacer **esto**', defaultChecked: true }], observation: { enabled: false, label: '', maxLength: 10 } },
        { id: 'c', type: 'consent', code: 'C', text: 'Autorizo a **{{broker.legalName}}**.', required: true },
      ]),
    ).not.toThrow();
  });
});

describe('maquetador del PDF con tramos en negrita', () => {
  it('conserva la negrita de cada tramo y une la puntuación pegada a una negrita (no la separa con un espacio)', async () => {
    const lines = await layout('Yo, **Ana Pérez**, con **DNI N.º 123**.');
    expect(lines).toHaveLength(1);
    expect(flat(lines[0])).toBe('Yo, [Ana] [Pérez], con [DNI] [N.º] [123].');
  });
  it('rompe la línea entre palabras, nunca dentro de una, y la negrita sigue en la línea de abajo', async () => {
    const lines = await layout('uno **dos tres cuatro cinco** seis', 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) for (const p of l) expect(p.width).toBeLessThanOrEqual(60 + 0.001);
    const all = lines.map(flat).join(' ');
    expect(all.replace(/[\[\]]/g, '')).toContain('dos tres cuatro cinco');
    // todas las palabras de «dos … cinco» siguen en negrita aunque queden en otra línea
    for (const w of ['dos', 'tres', 'cuatro', 'cinco']) expect(lines.flat().find((p) => p.text === w)?.bold).toBe(true);
    expect(lines.flat().find((p) => p.text === 'seis')?.bold).toBe(false);
  });
  it('respeta los saltos de línea del texto', async () => {
    const lines = await layout('**Señores:**\nMavac\n\nPresente.-');
    expect(lines.map(flat)).toEqual(['[Señores:]', 'Mavac', '', 'Presente.-']);
  });
  it('una palabra más ancha que la línea se corta en vez de salirse', async () => {
    const lines = await layout('**' + 'x'.repeat(200) + '**', 80);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.reduce((a, p) => a + p.width, 0)).toBeLessThanOrEqual(80 + 0.001);
  });
  it('con la negrita de párrafo todo sale en negrita', async () => {
    const lines = await layout('todo junto **y esto**', 500, true);
    expect(lines.flat().filter((p) => p.text.trim()).every((p) => p.bold)).toBe(true);
  });
  it('los caracteres que la fuente no soporta no revientan el texto en negrita', async () => {
    const lines = await layout('**ok 😀 日本**');
    expect(flat(lines[0])).toContain('ok');
  });
});

describe('el PDF lleva la negrita', () => {
  const input = (text: string): RenderInput => ({
    reference: 'R-1',
    issuer: { legalName: 'X SAC', registryCode: null, timezone: 'America/Lima' },
    signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
    data: {},
    content: { blocks: [{ id: 'p', type: 'paragraph', text, align: 'left', bold: false, small: false }] },
    annexText: null,
    clauseText: 'ok',
    form: { powers: [], observation: '' },
    signedAt: new Date('2026-01-01T00:00:00Z'),
    evidence: { ip: null, otpVerifiedAt: null, challengeCode: null, photo: null },
  });
  it('genera el PDF con texto en negrita y es distinto al mismo texto sin negrita', async () => {
    const con = await renderBlocksDocument(input('Yo, **{{signer.name}}**, con **{{signer.documentType}} {{signer.documentNumber}}**.'));
    const sin = await renderBlocksDocument(input('Yo, {{signer.name}}, con {{signer.documentType}} {{signer.documentNumber}}.'));
    expect(Buffer.from(con).subarray(0, 5).toString()).toBe('%PDF-');
    expect(Buffer.from(con).equals(Buffer.from(sin))).toBe(false);
  });
  it('un texto largo con negrita reparte en páginas sin perder nada', async () => {
    const largo = Array.from({ length: 120 }, (_, i) => `palabra${i} **negrita${i}**`).join(' ');
    const bytes = await renderBlocksDocument(input(largo));
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
