import { render, screen } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { documentTypeName, getDocumentTypeUi, listDocumentTypeUis } from '.';

describe('tipos de documento del panel', () => {
  it('cada tipo tiene código único, nombre y campos coherentes', () => {
    const tipos = listDocumentTypeUis();
    expect(new Set(tipos.map((t) => t.code)).size).toBe(tipos.length);
    for (const t of tipos) {
      expect(t.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(t.name.length).toBeGreaterThan(0);
      // Un borrador vacío NO es válido (si lo fuera, se podría crear una solicitud sin lo que el tipo exige) y nunca lanza.
      expect(Object.keys(t.validate(t.emptyDraft())).length).toBeGreaterThan(0);
    }
  });

  it('un tipo desconocido se muestra con su código, sin romper la pantalla', () => {
    expect(documentTypeName('OTRO_TIPO')).toBe('OTRO_TIPO');
    expect(getDocumentTypeUi('OTRO_TIPO')).toBeUndefined();
  });

  describe('carta de nombramiento', () => {
    const carta = getDocumentTypeUi('APPOINTMENT_LETTER')!;

    it('exige al menos un seguro y arma los datos que espera la API (uno por línea, sin vacíos)', () => {
      expect(carta.validate({ insurances: '  \n ' })).toHaveProperty('insurances');
      expect(carta.validate({ insurances: 'SCTR Salud' })).toEqual({});
      expect(carta.toData({ insurances: 'SCTR Salud\n\n  SCTR Pensión  \n' })).toEqual({ insurances: ['SCTR Salud', 'SCTR Pensión'] });
    });

    it('sus campos se dibujan y avisan al escribir', async () => {
      const cambio = vi.fn();
      render(<carta.Fields draft={{ insurances: '' }} errors={{ insurances: 'Ingrese al menos un seguro.' }} invalid={() => 'invalid'} onChange={cambio} />);
      expect(screen.getByLabelText(/Seguros que se nombran \*/)).toHaveClass('invalid');
      expect(screen.getByText('Ingrese al menos un seguro.')).toBeInTheDocument();
    });

    it('resume y detalla los seguros, y tolera datos que no los traen', () => {
      expect(carta.summary({ insurances: ['A', 'B'] })).toBe(2);
      expect(carta.summary({})).toBe('—');
      render(<>{carta.reviewSummary({ insurances: ['SCTR', 'Vida Ley'] })}</>);
      expect(screen.getByText(/SCTR · Vida Ley/)).toBeInTheDocument();
    });
  });

  /** La separación también vale en el panel: lo propio de la carta vive en su carpeta; el resto no la nombra. */
  it('el panel no menciona la carta fuera de su carpeta', () => {
    const SRC = join(__dirname, '..');
    const prohibido = /APPOINTMENT_LETTER|insurances|carta de nombramiento/i;
    const culpables: string[] = [];
    const recorrer = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) recorrer(p);
        else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p)) {
          const rel = relative(SRC, p).split(sep).join('/');
          if (!rel.startsWith('document-types/') && prohibido.test(readFileSync(p, 'utf8'))) culpables.push(rel);
        }
      }
    };
    recorrer(SRC);
    expect(culpables).toEqual([]);
  });
});
