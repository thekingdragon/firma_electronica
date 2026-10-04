import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { defaultTemplates } from '../tenants/default-templates';
import { makePng } from './image-fixtures';
import { imageInfo } from './image-info';
import { UnsupportedDocumentTypeError, renderDocument, resolveContent } from './render';
import type { RenderInput } from './types';

const tpl = defaultTemplates()[0];
const photo = makePng(1280, 720);

const input = (over: Partial<RenderInput> = {}): RenderInput => ({
  reference: 'FE-2026-ABCD1234',
  issuer: { legalName: 'Corredora Demo de Seguros S.A.C.', registryCode: 'J-0001' },
  signer: { name: 'Ana Pérez Quispe', documentType: 'DNI', documentNumber: '12345678' },
  data: { insurances: ['SCTR Salud', 'SCTR Pensión'] },
  content: tpl.bodyJson,
  annexText: tpl.annexText,
  clauseText: tpl.clauseText,
  form: { powers: ['GESTIONAR_SOLICITUD', 'RENOVACIONES'], observation: 'Solo para la sede de Ayacucho.' },
  signedAt: new Date(Date.UTC(2026, 9, 4, 17, 35, 12)),
  evidence: {
    ip: '203.0.113.7',
    otpVerifiedAt: new Date(Date.UTC(2026, 9, 4, 17, 34, 40)),
    challengeCode: '4821',
    photo: { bytes: photo, type: 'png', width: 1280, height: 720, sha256: createHash('sha256').update(photo).digest('hex') },
  },
  ...over,
});

async function pagesOf(bytes: Uint8Array) {
  return (await PDFDocument.load(bytes)).getPages().length;
}

describe('renderDocument (APPOINTMENT_LETTER)', () => {
  it('genera un PDF válido con la carta, el anexo y la constancia', async () => {
    const bytes = await renderDocument('APPOINTMENT_LETTER', input());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(await pagesOf(bytes)).toBeGreaterThanOrEqual(2);
  });

  it('pone los metadatos del documento, con la fecha de la firma', async () => {
    const doc = await PDFDocument.load(await renderDocument('APPOINTMENT_LETTER', input()));
    expect(doc.getTitle()).toBe('CARTA DE NOMBRAMIENTO FE-2026-ABCD1234');
    expect(doc.getAuthor()).toBe('Corredora Demo de Seguros S.A.C.');
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-10-04T17:35:12.000Z');
  });

  it('es determinista: el mismo input da los mismos bytes', async () => {
    const a = await renderDocument('APPOINTMENT_LETTER', input());
    const b = await renderDocument('APPOINTMENT_LETTER', input());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('un input distinto (otra facultad marcada) cambia el documento', async () => {
    const a = await renderDocument('APPOINTMENT_LETTER', input());
    const b = await renderDocument('APPOINTMENT_LETTER', input({ form: { powers: ['AJUSTADOR'], observation: '' } }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('sin foto ni OTP (política del tipo) genera igual', async () => {
    const bytes = await renderDocument(
      'APPOINTMENT_LETTER',
      input({ evidence: { ip: null, otpVerifiedAt: null, challengeCode: null, photo: null } }),
    );
    expect(await pagesOf(bytes)).toBeGreaterThanOrEqual(1);
  });

  it('sin anexo genera menos páginas', async () => {
    const con = await pagesOf(await renderDocument('APPOINTMENT_LETTER', input()));
    const sin = await pagesOf(await renderDocument('APPOINTMENT_LETTER', input({ annexText: null })));
    expect(sin).toBeLessThan(con);
  });

  it('no revienta con caracteres que la fuente no soporta (emoji, CJK) ni con textos larguísimos', async () => {
    const raro = 'Observación 😀 日本語 ' + 'palabra '.repeat(400) + 'X'.repeat(300);
    const bytes = await renderDocument(
      'APPOINTMENT_LETTER',
      input({ form: { powers: [], observation: raro }, signer: { name: 'Zoë Ñandú 😀', documentType: 'CE', documentNumber: '99' } }),
    );
    expect(await pagesOf(bytes)).toBeGreaterThanOrEqual(2);
  });

  it('muchos seguros no pierden contenido: reparte en páginas', async () => {
    const muchos = Array.from({ length: 20 }, (_, i) => `Seguro número ${i + 1} con una descripción bastante larga`);
    const bytes = await renderDocument('APPOINTMENT_LETTER', input({ data: { insurances: muchos } }));
    expect(await pagesOf(bytes)).toBeGreaterThanOrEqual(3);
  });

  it('una plantilla con textos propios los usa en lugar de los de partida', async () => {
    const propio = await renderDocument(
      'APPOINTMENT_LETTER',
      input({ content: { ...tpl.bodyJson, texts: { title: 'APPOINTMENT LETTER' } } }),
    );
    expect((await PDFDocument.load(propio)).getTitle()).toBe('APPOINTMENT LETTER FE-2026-ABCD1234');
  });

  it('los saltos de línea del texto no se dibujan como «?»', async () => {
    const { PdfFlow } = await import('./pdf-flow');
    const f = await PdfFlow.create();
    // Cada salto de línea del texto es una línea del documento; ninguno se vuelve «?».
    expect(f.measureLines('linea uno\nlinea dos')).toEqual(['linea uno', 'linea dos']);
    expect(f.measureLines('a\r\nb')).toEqual(['a', 'b']);
    expect(f.measureLines('uno\n\ndos')).toEqual(['uno', '', 'dos']);
    // Y lo que la fuente no soporta sí se limpia, sin tocar los saltos.
    expect(f.measureLines('ok 😀\nfin')).toEqual(['ok ?', 'fin']);
  });

  describe('con una foto JPEG REAL (la que entrega la cámara del navegador)', () => {
    // La cámara produce JPEG, no PNG: esta es la ruta de producción. Antes solo se probaba con PNG
    // sintéticos y un defecto con los JPEG pasó inadvertido hasta verlo firmar de verdad.
    const jpeg = readFileSync(join(__dirname, 'fixtures', 'camera-1280x720.jpg'));
    const withPhoto = (bytes: Buffer): Partial<RenderInput> => ({
      evidence: {
        ip: '203.0.113.7',
        otpVerifiedAt: new Date(Date.UTC(2026, 9, 4, 17, 34, 40)),
        challengeCode: '4821',
        photo: { bytes, type: 'jpeg', width: 1280, height: 720, sha256: createHash('sha256').update(bytes).digest('hex') },
      },
    });

    /** Los bytes de las imágenes JPEG (DCTDecode) que el PDF lleva incrustadas, tal cual. */
    async function embeddedJpegs(pdf: Uint8Array): Promise<Buffer[]> {
      const doc = await PDFDocument.load(pdf);
      const out: Buffer[] = [];
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Filter'))?.toString() === '/DCTDecode') {
          out.push(Buffer.from(obj.contents));
        }
      }
      return out;
    }

    it('el lector de dimensiones lee un JPEG de verdad, no solo la cabecera armada a mano', () => {
      expect(imageInfo(jpeg)).toEqual({ type: 'jpeg', mime: 'image/jpeg', width: 1280, height: 720 });
    });

    it('genera el PDF y la imagen incrustada es EXACTAMENTE la foto, sin recomprimir', async () => {
      const pdf = await renderDocument('APPOINTMENT_LETTER', input(withPhoto(jpeg)));
      const imgs = await embeddedJpegs(pdf);
      expect(imgs).toHaveLength(1);
      expect(imgs[0].equals(jpeg)).toBe(true);
    });

    it('REGRESIÓN: un Buffer que es una PORCIÓN de un bloque mayor también funciona', async () => {
      // multer y Node entregan así los buffers según cómo caiga la asignación de memoria. pdf-lib los
      // rechazaba con «SOI not found in JPEG», y fallaba solo a veces: no se veía en las pruebas.
      for (const offset of [1, 100, 4096, 8191]) {
        const grande = Buffer.concat([Buffer.alloc(offset, 7), jpeg, Buffer.alloc(offset, 9)]);
        const porcion = grande.subarray(offset, offset + jpeg.length);
        expect(porcion.byteOffset).toBeGreaterThan(0);
        const pdf = await renderDocument('APPOINTMENT_LETTER', input(withPhoto(porcion)));
        const imgs = await embeddedJpegs(pdf);
        expect(imgs).toHaveLength(1);
        expect(imgs[0].equals(jpeg)).toBe(true);
      }
    });
  });

  describe('resolveContent', () => {
    it('completa los textos que la plantilla no trae con los de partida', () => {
      const r = resolveContent('APPOINTMENT_LETTER', { powers: [], texts: { title: 'MI TITULO' } });
      const t = r.texts as Record<string, string>;
      expect(t.title).toBe('MI TITULO');
      expect(t.greeting).toBe('Estimados señores:');
    });

    it('una plantilla sin texts recibe todos los de partida', () => {
      const t = resolveContent('APPOINTMENT_LETTER', { powers: [] }).texts as Record<string, string>;
      expect(t.title).toBe('CARTA DE NOMBRAMIENTO');
      expect(Object.keys(t).length).toBeGreaterThan(8);
    });

    it('no modifica el contenido original ni toca el de otros tipos', () => {
      const original = { powers: [{ code: 'A' }] };
      resolveContent('APPOINTMENT_LETTER', original);
      expect(original).toEqual({ powers: [{ code: 'A' }] });
      expect(resolveContent('OTRO', { x: 1 })).toEqual({ x: 1 });
    });
  });

  it('un tipo sin generador se rechaza con un error propio', () => {
    expect(() => renderDocument('CONTRATO_X', input())).toThrow(UnsupportedDocumentTypeError);
  });
});
