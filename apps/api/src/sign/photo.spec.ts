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

  describe('checkResolution de la foto del documento (recortada al marco)', () => {
    it('acepta un recorte de DNI legible y rechaza uno pequeño', () => {
      expect(checkResolution({ width: 1080, height: 681 }, 'id')).toBeNull();
      expect(checkResolution({ width: 1000, height: 600 }, 'id')).toBeNull();
      expect(checkResolution({ width: 999, height: 600 }, 'id')).not.toBeNull();
      expect(checkResolution({ width: 1000, height: 599 }, 'id')).not.toBeNull();
      // La selfie tiene su propio piso (más bajo, porque sale recortada): este recorte también le alcanza.
      expect(checkResolution({ width: 1080, height: 681 })).toBeNull();
    });
  });

  describe('checkResolution', () => {
    it('acepta la selfie vertical de una cámara de laptop de 720p (553×691) y las de un celular', () => {
      expect(checkResolution({ width: 553, height: 691 })).toBeNull();
      expect(checkResolution({ width: 1037, height: 1296 })).toBeNull();
      expect(checkResolution({ width: 1280, height: 720 })).toBeNull();
      expect(checkResolution({ width: 720, height: 1280 })).toBeNull();
      expect(checkResolution({ width: 1920, height: 1080 })).toBeNull();
    });

    it('rechaza lo que no llega al piso, con un mensaje que dice qué tamaño llegó', () => {
      expect(checkResolution({ width: 640, height: 480 })).toMatch(/640×480/);
      // Una cámara de 480p recortada en vertical (368×460) es demasiado chica para ver el rostro y el número.
      expect(checkResolution({ width: 368, height: 460 })).not.toBeNull();
      expect(checkResolution({ width: 539, height: 691 })).not.toBeNull();
      expect(checkResolution({ width: 553, height: 639 })).not.toBeNull();
    });

    it('una foto muy larga y angosta no pasa por tener un lado grande', () => {
      expect(checkResolution({ width: 4000, height: 200 })).not.toBeNull();
    });
  });
});
