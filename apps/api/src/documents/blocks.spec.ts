import { PDFDocument } from 'pdf-lib';
import {
  BlocksError,
  Block,
  VariableContext,
  blocksFromLegacy,
  fillVariables,
  parseBlocks,
  powersBlockOf,
  resolveBlocks,
  toViewBlocks,
  unknownVariables,
} from './blocks';
import { formSchemaFor } from './form-schemas';
import { renderBlocksDocument } from './render-blocks';
import type { RenderInput } from './types';

const ctx: VariableContext = {
  brokerLegalName: 'Mavac Corredores de Seguros SAC',
  brokerRegistryCode: 'J701',
  signerName: 'Ana Pérez',
  signerDocumentType: 'DNI',
  signerDocumentNumber: '12345678',
  reference: 'FE-2026-ABC',
  date: '22 de julio de 2026',
};

const base: Block[] = [
  { id: 'enc', type: 'issuerHeader', showRegistry: true, showDate: true },
  { id: 'tit', type: 'title', text: 'CARTA {{broker.legalName}}' },
  { id: 'par', type: 'paragraph', text: 'Yo, {{signer.name}} ({{signer.documentType}} {{signer.documentNumber}})', align: 'left', bold: false, small: false },
  {
    id: 'fac',
    type: 'powers',
    intro: 'Facultades:',
    items: [
      { code: 'A', text: 'Primera', defaultChecked: true },
      { code: 'B', text: 'Segunda', defaultChecked: false },
    ],
    observation: { enabled: true, label: 'Observación:', maxLength: 200 },
  },
  { id: 'sello', type: 'signatureStamp' },
];

const errorOf = (input: unknown): BlocksError => {
  try {
    parseBlocks(input);
  } catch (e) {
    return e as BlocksError;
  }
  throw new Error('debía lanzar BlocksError');
};

describe('variables', () => {
  it('completa las conocidas y deja las desconocidas', () => {
    expect(fillVariables('{{signer.name}} / {{ reference }} / {{nada}}', ctx)).toBe('Ana Pérez / FE-2026-ABC / {{nada}}');
  });
  it('un código de registro vacío queda como texto vacío, no como «null»', () => {
    expect(fillVariables('[{{broker.registryCode}}]', { ...ctx, brokerRegistryCode: null })).toBe('[]');
  });
  it('detecta las variables que no existen', () => {
    expect(unknownVariables('{{signer.name}} {{broker.ruc}} {{x}}')).toEqual(['broker.ruc', 'x']);
  });
  it('no interpreta nada más que variables: ni HTML ni expresiones', () => {
    expect(fillVariables('<b>{{signer.name}}</b> ${1+1} {{constructor}}', ctx)).toBe('<b>Ana Pérez</b> ${1+1} {{constructor}}');
  });
});

describe('parseBlocks', () => {
  it('acepta una lista válida y completa los valores por defecto', () => {
    const r = parseBlocks([{ id: 'p', type: 'paragraph', text: 'hola' }]);
    expect(r[0]).toMatchObject({ align: 'left', bold: false, small: false });
  });

  it('rechaza lo que no es una lista, una lista vacía y demasiados bloques', () => {
    expect(errorOf('x').issues[0].message).toMatch(/lista/);
    expect(errorOf([]).issues[0].message).toMatch(/al menos un bloque/);
    const muchos = Array.from({ length: 81 }, (_, i) => ({ id: `b${i}`, type: 'pageBreak' }));
    expect(errorOf(muchos).issues[0].message).toMatch(/demasiados/);
  });

  it('rechaza un tipo de bloque desconocido y los campos que no existen (nada se ignora en silencio)', () => {
    expect(errorOf([{ id: 'a', type: 'script', text: 'x' }]).issues.length).toBeGreaterThan(0);
    expect(errorOf([{ id: 'a', type: 'paragraph', text: 'x', html: '<b>' }]).issues.length).toBeGreaterThan(0);
  });

  it('dice DÓNDE está cada problema (bloque e ítem)', () => {
    const e = errorOf([
      { id: 'a', type: 'pageBreak' },
      { id: 'b', type: 'powers', intro: '', items: [{ code: 'minuscula', text: 'x' }], observation: { enabled: false, label: '', maxLength: 10 } },
    ]);
    expect(e.issues[0].path).toMatch(/bloque 2 › items › 1 › code/);
  });

  it('rechaza una variable que no existe, diciendo cuáles hay', () => {
    const e = errorOf([{ id: 'a', type: 'title', text: 'Hola {{cliente.ruc}}' }]);
    expect(e.issues[0].message).toContain('{{cliente.ruc}}');
    expect(e.issues[0].message).toContain('{{signer.name}}');
  });

  it('rechaza identificadores repetidos y códigos de facultad repetidos', () => {
    expect(errorOf([{ id: 'a', type: 'pageBreak' }, { id: 'a', type: 'pageBreak' }]).issues[0].message).toMatch(/repetido/);
    const e = errorOf([
      {
        id: 'f',
        type: 'powers',
        intro: '',
        items: [
          { code: 'A', text: 'uno' },
          { code: 'A', text: 'dos' },
        ],
        observation: { enabled: false, label: '', maxLength: 10 },
      },
    ]);
    expect(e.issues[0].message).toMatch(/«A» está repetido/);
  });

  it('solo un bloque de facultades, de firma, de encabezado y de datos del firmante', () => {
    for (const type of ['issuerHeader', 'signatureStamp', 'signerBox'] as const) {
      const uno = type === 'issuerHeader' ? { type, showRegistry: true, showDate: true } : type === 'signerBox' ? { type, title: 'x' } : { type };
      const e = errorOf([{ id: 'a', ...uno }, { id: 'b', ...uno }]);
      expect(e.issues.some((i) => i.message.includes(`«${type}»`))).toBe(true);
    }
  });

  it('un código de facultad en minúscula o con espacios no vale', () => {
    const mk = (code: string) => [{ id: 'f', type: 'powers', intro: '', items: [{ code, text: 'x' }], observation: { enabled: false, label: '', maxLength: 10 } }];
    expect(() => parseBlocks(mk('RENOVACIONES'))).not.toThrow();
    expect(() => parseBlocks(mk('renovaciones'))).toThrow(BlocksError);
    expect(() => parseBlocks(mk('A B'))).toThrow(BlocksError);
  });

  it('rechaza un documento demasiado largo', () => {
    const largo = Array.from({ length: 19 }, (_, i) => ({ id: `p${i}`, type: 'paragraph', text: 'x'.repeat(4900) }));
    expect(errorOf(largo).issues.some((i) => /demasiado largo/.test(i.message))).toBe(true);
  });
});

describe('plantillas anteriores a los bloques', () => {
  const legacy = {
    powers: [
      { code: 'RENOVACIONES', text: 'Renovar', defaultChecked: true },
      { code: 'AJUSTADOR', text: 'Designar ajustador', defaultChecked: false },
    ],
    observation: { maxLength: 300 },
    texts: { title: 'MI CARTA' },
  };

  it('se leen como los bloques equivalentes y esos bloques son válidos', () => {
    const blocks = blocksFromLegacy(legacy, 'Obligaciones\n\na. Algo');
    expect(() => parseBlocks(blocks)).not.toThrow();
    expect(blocks.find((b) => b.type === 'title')).toMatchObject({ text: 'MI CARTA' });
    const p = powersBlockOf(blocks)!;
    expect(p.items.map((i) => i.code)).toEqual(['RENOVACIONES', 'AJUSTADOR']);
    expect(p.items[1].defaultChecked).toBe(false);
    expect(p.observation).toMatchObject({ enabled: true, maxLength: 300 });
    expect(blocks.some((b) => b.type === 'annex')).toBe(true);
  });

  it('sin anexo no hay bloque de anexo', () => {
    expect(blocksFromLegacy(legacy, null).some((b) => b.type === 'annex')).toBe(false);
  });

  it('resolveBlocks usa los bloques propios si existen y, si no, los anteriores', () => {
    expect(resolveBlocks({ blocks: base }, 'ignorado').some((b) => b.type === 'annex')).toBe(false);
    expect(resolveBlocks(legacy, 'texto').some((b) => b.type === 'annex')).toBe(true);
  });

  it('unos bloques guardados que no son válidos NO se tratan como «no hay»: es un error', () => {
    expect(() => resolveBlocks({ blocks: [{ id: 'x', type: 'raro' }] }, null)).toThrow(BlocksError);
  });
});

describe('toViewBlocks (lo que ve el firmante)', () => {
  const view = toViewBlocks(
    [...base, { id: 'seg', type: 'dataList', dataKey: 'insurances', style: 'letters' }, { id: 'f', type: 'signerBox', title: 'Datos' }],
    ctx,
    { insurances: ['SCTR', '', 'Vida'] },
  );

  it('completa las variables de todos los textos', () => {
    expect(view.find((b) => b.type === 'title')).toMatchObject({ text: 'CARTA Mavac Corredores de Seguros SAC' });
    expect(view.find((b) => b.type === 'paragraph')).toMatchObject({ text: 'Yo, Ana Pérez (DNI 12345678)' });
  });
  it('una lista de datos llega ya resuelta como lista (sin los vacíos)', () => {
    expect(view.find((b) => b.id === 'seg')).toEqual({ id: 'seg', type: 'list', items: ['SCTR', 'Vida'], style: 'letters' });
  });
  it('el encabezado respeta qué mostrar', () => {
    const v = toViewBlocks([{ id: 'e', type: 'issuerHeader', showRegistry: false, showDate: false }], ctx, {});
    expect(v[0]).toMatchObject({ registryCode: null, date: null });
  });
});

describe('formulario de la plantilla con bloques', () => {
  it('sale del bloque de facultades', () => {
    const s = formSchemaFor('APPOINTMENT_LETTER', { blocks: base })!;
    expect(s.safeParse({ powers: ['A'], observation: '' }).success).toBe(true);
    expect(s.safeParse({ powers: ['Z'], observation: '' }).success).toBe(false);
    expect(s.safeParse({ powers: [], observation: '' }).success).toBe(false);
    expect(s.safeParse({ powers: [], observation: 'solo observación' }).success).toBe(true);
  });

  it('sin observación habilitada, una observación no se acepta', () => {
    const sin = base.map((b) => (b.type === 'powers' ? { ...b, observation: { ...b.observation, enabled: false } } : b));
    const s = formSchemaFor('APPOINTMENT_LETTER', { blocks: sin })!;
    expect(s.safeParse({ powers: ['A'], observation: 'algo' }).success).toBe(false);
    expect(s.safeParse({ powers: ['A'], observation: '' }).success).toBe(true);
    expect(s.safeParse({ powers: [], observation: '' }).success).toBe(false);
  });

  it('una plantilla sin bloque de facultades no pide nada: el formulario va vacío', () => {
    const s = formSchemaFor('APPOINTMENT_LETTER', { blocks: [{ id: 't', type: 'title', text: 'x' }] })!;
    expect(s.safeParse({ powers: [], observation: '' }).success).toBe(true);
    expect(s.safeParse({ powers: ['A'], observation: '' }).success).toBe(false);
  });

  it('con bloques inválidos no hay formulario (no se puede firmar)', () => {
    expect(formSchemaFor('APPOINTMENT_LETTER', { blocks: [{ id: 'x', type: 'raro' }] })).toBeNull();
  });
});

describe('renderBlocksDocument', () => {
  const input = (over: Partial<RenderInput> = {}): RenderInput => ({
    reference: 'FE-2026-ABC',
    issuer: { legalName: ctx.brokerLegalName, registryCode: 'J701' },
    signer: { name: 'Ana Pérez', documentType: 'DNI', documentNumber: '12345678' },
    data: { insurances: ['SCTR', 'Vida'] },
    content: { blocks: base },
    annexText: null,
    clauseText: 'Acepto firmar electrónicamente.',
    form: { powers: ['A'], observation: '' },
    signedAt: new Date('2026-07-22T21:14:59Z'),
    evidence: { ip: '1.2.3.4', otpVerifiedAt: null, challengeCode: null, photo: null, idPhoto: null },
    ...over,
  });
  const pages = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();

  it('genera un PDF válido con bloques propios', async () => {
    const bytes = await renderBlocksDocument(input());
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await pages(bytes)).toBeGreaterThanOrEqual(1);
  });

  it('un bloque de anexo abre una página nueva; uno de salto de página también', async () => {
    const sin = await pages(await renderBlocksDocument(input()));
    const con = await pages(
      await renderBlocksDocument(input({ content: { blocks: [...base, { id: 'x', type: 'annex', title: 'ANEXO', subtitle: '', text: 'Texto del anexo' }] } })),
    );
    expect(con).toBeGreaterThan(sin);
    const salto = await pages(await renderBlocksDocument(input({ content: { blocks: [...base, { id: 's', type: 'pageBreak' }, { id: 'p2', type: 'paragraph', text: 'otra', align: 'left', bold: false, small: false }] } })));
    expect(salto).toBeGreaterThan(sin);
  });

  it('el PDF cambia cuando cambian las facultades que el firmante marcó', async () => {
    const a = await renderBlocksDocument(input());
    const b = await renderBlocksDocument(input({ form: { powers: ['A', 'B'], observation: '' } }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('el mismo contenido da el mismo PDF (la fecha de creación es la de la firma)', async () => {
    const a = await renderBlocksDocument(input());
    const b = await renderBlocksDocument(input());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('una plantilla sin ningún bloque de contenido igual lleva la constancia de la firma', async () => {
    const bytes = await renderBlocksDocument(input({ content: { blocks: [{ id: 't', type: 'title', text: 'SOLO TITULO' }] } }));
    expect(await pages(bytes)).toBe(1);
  });

  it('con bloques inválidos no genera nada', async () => {
    await expect(renderBlocksDocument(input({ content: { blocks: [{ id: 'x', type: 'raro' }] } }))).rejects.toThrow(BlocksError);
  });
});
