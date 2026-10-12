import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseBlocks } from '../documents/blocks';
import { getDocumentType, listDocumentTypes } from '.';

const SRC = join(__dirname, '..');

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) yield p;
  }
}

describe('tipos de documento', () => {
  it('cada tipo tiene un código válido y único, y una plantilla de partida coherente', () => {
    const codes = listDocumentTypes().map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const d of listDocumentTypes()) {
      expect(d.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(d.name.length).toBeGreaterThan(0);
      const seed = d.defaultTemplate();
      expect(seed.documentType).toBe(d.code);
      // La plantilla de partida debe ser válida: una corredora nueva no puede nacer con un documento que no se firma.
      expect(() => parseBlocks((seed.bodyJson as { blocks: unknown }).blocks)).not.toThrow();
      expect(d.formSchema(seed.bodyJson)).not.toBeNull();
      expect(getDocumentType(d.code)).toBe(d);
    }
  });

  it('un tipo que no existe no se resuelve', () => {
    expect(getDocumentType('NO_EXISTE')).toBeUndefined();
  });

  /**
   * LA SEPARACIÓN: el servicio de firmas no conoce la carta de nombramiento. Todo lo propio de un tipo de documento vive en
   * `document-types/<tipo>/`; el núcleo (solicitudes, firma, evidencia, sello, panel, auth…) solo habla con el registro.
   * Si esta prueba falla, algo propio de la carta se coló en el núcleo: moverlo a su carpeta.
   */
  it('el núcleo no menciona ningún tipo de documento concreto', () => {
    const prohibido = /APPOINTMENT_LETTER|appointment-letter|appointmentLetter|DEFAULT_LETTER_TEXTS|carta de nombramiento/i;
    const culpables: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (rel.startsWith('document-types/')) continue;
      if (prohibido.test(readFileSync(file, 'utf8'))) culpables.push(rel);
    }
    expect(culpables).toEqual([]);
  });
});
