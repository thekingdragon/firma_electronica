import { checkResolution, generateChallengeCode } from './photo';

describe('photo', () => {
  describe('generateChallengeCode', () => {
    it('siempre son 4 dígitos, también con ceros a la izquierda', () => {
      for (let i = 0; i < 2000; i++) expect(generateChallengeCode()).toMatch(/^\d{4}$/);
    });

    it('cubre el rango (aparecen valores bajos con ceros)', () => {
      const seen = new Set(Array.from({ length: 4000 }, generateChallengeCode));
      expect(seen.size).toBeGreaterThan(2000);
      expect([...seen].some((c) => c.startsWith('0'))).toBe(true);
    });
  });

  describe('checkResolution', () => {
    it('acepta 1280×720 y más, en horizontal o vertical', () => {
      expect(checkResolution({ width: 1280, height: 720 })).toBeNull();
      expect(checkResolution({ width: 720, height: 1280 })).toBeNull();
      expect(checkResolution({ width: 1920, height: 1080 })).toBeNull();
    });

    it('rechaza lo que no llega al piso, con un mensaje que dice qué tamaño llegó', () => {
      expect(checkResolution({ width: 640, height: 480 })).toMatch(/640×480/);
      expect(checkResolution({ width: 1279, height: 720 })).not.toBeNull();
      expect(checkResolution({ width: 1280, height: 719 })).not.toBeNull();
    });

    it('una foto muy larga y angosta no pasa por tener un lado grande', () => {
      expect(checkResolution({ width: 4000, height: 200 })).not.toBeNull();
    });
  });
});
