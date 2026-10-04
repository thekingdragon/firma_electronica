import { randomCode, sha256Hex, signTokenFor } from './crypto';

const SECRET = 'x'.repeat(32);

describe('crypto', () => {
  it('sha256Hex da el hash conocido', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  describe('signTokenFor', () => {
    it('es determinista para el mismo id y secreto', () => {
      expect(signTokenFor('id-1', SECRET)).toBe(signTokenFor('id-1', SECRET));
    });

    it('cambia con el id', () => {
      expect(signTokenFor('id-1', SECRET)).not.toBe(signTokenFor('id-2', SECRET));
    });

    it('cambia con el secreto', () => {
      expect(signTokenFor('id-1', SECRET)).not.toBe(signTokenFor('id-1', 'y'.repeat(32)));
    });

    it('es base64url de 43 caracteres, apto para una URL', () => {
      expect(signTokenFor('id-1', SECRET)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe('randomCode', () => {
    it('tiene el largo pedido y solo caracteres legibles', () => {
      expect(randomCode(8)).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    });

    it('no repite en 1000 intentos de 8 caracteres', () => {
      const vistos = new Set(Array.from({ length: 1000 }, () => randomCode(8)));
      expect(vistos.size).toBe(1000);
    });
  });
});
