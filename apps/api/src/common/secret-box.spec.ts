import { randomBytes } from 'node:crypto';
import { open, parseSecretsKey, seal } from './secret-box';

const KEY = randomBytes(32);

describe('secret-box', () => {
  it('cifra y descifra', () => {
    expect(open(KEY, 'smtp-password', seal(KEY, 'smtp-password', 'clave-secreta'))).toBe('clave-secreta');
  });

  it('el valor cifrado no contiene el texto original', () => {
    expect(seal(KEY, 'smtp-password', 'clave-secreta')).not.toContain('clave-secreta');
  });

  it('cifrar dos veces lo mismo da resultados distintos (IV nuevo)', () => {
    expect(seal(KEY, 'smtp-password', 'x')).not.toBe(seal(KEY, 'smtp-password', 'x'));
  });

  it('con otra clave no descifra', () => {
    const sealed = seal(KEY, 'smtp-password', 'x');
    expect(() => open(randomBytes(32), 'smtp-password', sealed)).toThrow();
  });

  it('con otro propósito no descifra (subclaves independientes)', () => {
    const sealed = seal(KEY, 'smtp-password', 'x');
    expect(() => open(KEY, 'files', sealed)).toThrow();
  });

  it('detecta un valor alterado', () => {
    const [v, iv, tag, data] = seal(KEY, 'smtp-password', 'hola').split(':');
    const roto = [v, iv, tag, Buffer.from('otro dato').toString('base64')].join(':');
    expect(() => open(KEY, 'smtp-password', roto)).toThrow();
  });

  it('rechaza un formato desconocido', () => {
    expect(() => open(KEY, 'smtp-password', 'v9:a:b:c')).toThrow(/formato desconocido/);
    expect(() => open(KEY, 'smtp-password', 'texto-suelto')).toThrow(/formato desconocido/);
  });

  describe('parseSecretsKey', () => {
    it('acepta base64 y hexadecimal de 32 bytes', () => {
      const b = randomBytes(32);
      expect(parseSecretsKey(b.toString('base64')).equals(b)).toBe(true);
      expect(parseSecretsKey(b.toString('hex')).equals(b)).toBe(true);
    });

    it('rechaza una clave de otro tamaño', () => {
      expect(() => parseSecretsKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    });
  });
});
