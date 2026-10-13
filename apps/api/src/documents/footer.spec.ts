import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { defaultTemplates } from '../tenants/default-templates';
import { MAX_FOOTER, VARIABLES, VariableContext, fillVariables, footerOf, footerProblems } from './blocks';
import { renderDocument } from './render';
import type { RenderInput } from './types';

const ctx: VariableContext = {
  brokerLegalName: 'Mavac Corredores de Seguros',
  brokerRegistryCode: null,
  signerName: 'Gustavo Javier Martinez Cerron',
  signerDocumentType: 'DNI',
  signerDocumentNumber: '72397064',
  reference: 'FE-2026-X',
  date: '13 de octubre de 2026',
  attendedBy: 'Ana Atiende',
};

const letter = defaultTemplates().find((t) => t.documentType === 'APPOINTMENT_LETTER')!;

const input = (over: Partial<RenderInput> = {}): RenderInput => ({
  reference: 'FE-2026-X',
  attendedBy: 'Ana Atiende',
  issuer: { legalName: 'Mavac Corredores de Seguros', registryCode: null, timezone: 'America/Lima' },
  signer: { name: 'Gustavo Javier Martinez Cerron', documentType: 'DNI', documentNumber: '72397064' },
  data: { insurances: ['SCTR'] },
  content: letter.bodyJson,
  annexText: null,
  clauseText: 'Acepto.',
  form: { powers: [], observation: '', consents: ['DATOS_PERSONALES'] },
  signedAt: new Date(Date.UTC(2026, 9, 13, 18, 0, 0)),
  evidence: { ip: '127.0.0.1', otpVerifiedAt: new Date(), challengeCode: null, photo: null },
  ...over,
});

/** El contenido de cada página: las cadenas de texto que dibuja (hexadecimales en WinAnsi) y la altura de cada una. */
async function pagesText(bytes: Uint8Array): Promise<Array<{ text: string; ys: number[] }>> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    let stream = '';
    for (const r of refs) {
      const obj = r instanceof PDFRef ? doc.context.lookup(r) : r;
      if (obj instanceof PDFRawStream) stream += Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1') + '\n';
    }
    const text = [...stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('\n');
    const ys = [...stream.matchAll(/1 0 0 1 [-\d.]+ ([-\d.]+) Tm/g)].map((m) => Number(m[1]));
    void PDFName;
    return { text, ys };
  });
}

describe('pie de página de la plantilla', () => {
  it('la carta de partida lo lleva (y ya no abre con los datos del cliente ni la fecha)', () => {
    const body = letter.bodyJson as { footer?: string; blocks: Array<{ id: string }> };
    expect(body.footer).toContain('{{signer.name}}');
    expect(body.footer).toContain('{{attendedBy}}');
    expect(body.blocks.map((b) => b.id)).not.toContain('cliente');
    expect(body.blocks.map((b) => b.id)).not.toContain('fecha');
    expect(footerProblems(body.footer ?? '')).toEqual([]);
  });

  it('las variables se completan; «quién atendió» sin dato queda como raya, no como «null»', () => {
    const t = 'Atendido por: **{{attendedBy}}** · {{signer.name}} · {{date}}';
    expect(fillVariables(t, ctx)).toBe('Atendido por: **Ana Atiende** · Gustavo Javier Martinez Cerron · 13 de octubre de 2026');
    expect(fillVariables(t, { ...ctx, attendedBy: null })).toContain('Atendido por: **—**');
    expect(fillVariables(t, { ...ctx, attendedBy: undefined })).toContain('**—**');
    expect(VARIABLES.map((v) => v.name)).toContain('attendedBy');
  });

  it('un nombre con «**» no puede abrir una negrita en medio del pie', () => {
    expect(fillVariables('{{attendedBy}}', { ...ctx, attendedBy: 'Ana **Admin**' })).toBe('Ana Admin');
  });

  it('se valida: variable inexistente, negrita sin pareja y largo', () => {
    expect(footerProblems('Hola {{noexiste}}').join(' ')).toMatch(/noexiste/);
    expect(footerProblems('abre ** y no cierra').join(' ')).toMatch(/\*\*/);
    expect(footerProblems('x'.repeat(MAX_FOOTER + 1)).join(' ')).toMatch(/demasiado largo/);
    expect(footerProblems('')).toEqual([]);
    expect(footerOf({ footer: '  texto  ' })).toBe('texto');
    expect(footerOf({})).toBe('');
    expect(footerOf({ footer: 42 })).toBe('');
  });

  it('sale en el PDF, con el nombre, el documento, la fecha de Lima y quién atendió', async () => {
    const pages = await pagesText(await renderDocument('APPOINTMENT_LETTER', input()));
    // El pie se dibuja palabra por palabra (para respetar la negrita): se compara el texto corrido.
    const todo = pages.map((p) => p.text.replace(/\n/g, ' ')).join(' ');
    expect(todo).toContain('Nombres y apellidos:');
    expect(todo).toContain('Gustavo Javier Martinez Cerron');
    expect(todo).toContain('72397064');
    expect(todo).toContain('13 de octubre de 2026');
    expect(todo).toContain('Atendido por:');
    expect(todo).toContain('Ana Atiende');
  });

  it('sale en TODAS las hojas y el cuerpo nunca invade su espacio', async () => {
    const relleno = Array.from({ length: 45 }, (_, i) => ({
      id: `relleno${i}`,
      type: 'paragraph',
      align: 'left',
      bold: false,
      small: false,
      text: `Obligación número ${i} del corredor, con un texto lo bastante largo para ocupar su línea y obligar a pasar de página.`,
    }));
    const base = (letter.bodyJson as { blocks: unknown[] }).blocks;
    const pages = await pagesText(await renderDocument('APPOINTMENT_LETTER', input({ content: { ...letter.bodyJson, blocks: [...base.slice(0, 3), ...relleno, ...base.slice(3)] } })));
    expect(pages.length).toBeGreaterThan(2);
    for (const [i, p] of pages.entries()) {
      const plano = p.text.replace(/\n/g, ' ');
      expect(plano).toContain('Atendido por:');
      expect(plano).toContain('Ana Atiende');
      expect(plano).toContain(`Página ${i + 1} de ${pages.length}`);
      // Por debajo del área de contenido solo cabe el pie (a lo sumo 3 líneas) y la línea de referencia y página.
      // Cada palabra es un trozo de texto aparte: se cuentan las ALTURAS distintas (las líneas), no los trozos.
      const lineasAbajo = new Set(p.ys.filter((y) => y < 56 + 34).map((y) => Math.round(y)));
      expect(lineasAbajo.size).toBeLessThanOrEqual(1 + 3);
      expect(lineasAbajo.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('sin pie de página en la plantilla, el PDF sale como antes (solo la referencia y la página)', async () => {
    const sin = { ...(letter.bodyJson as Record<string, unknown>) };
    delete sin.footer;
    const pages = await pagesText(await renderDocument('APPOINTMENT_LETTER', input({ content: sin })));
    expect(pages.map((p) => p.text).join('\n')).not.toContain('Atendido por');
  });
});
