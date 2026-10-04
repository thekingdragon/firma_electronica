import { randomBytes } from 'node:crypto';
import { open, openBytes, parseSecretsKey, seal, sealBytes } from './secret-box';

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

  describe('sealBytes / openBytes', () => {
    const foto = randomBytes(5000);

    it('cifra y descifra un binario byte a byte', () => {
      expect(openBytes(KEY, 'files', sealBytes(KEY, 'files', foto)).equals(foto)).toBe(true);
    });

    it('el resultado no contiene el original y cambia en cada cifrado', () => {
      const a = sealBytes(KEY, 'files', foto);
      expect(a.includes(foto.subarray(0, 64))).toBe(false);
      expect(a.equals(sealBytes(KEY, 'files', foto))).toBe(false);
    });

    it('soporta un archivo vacío', () => {
      expect(openBytes(KEY, 'files', sealBytes(KEY, 'files', Buffer.alloc(0))).length).toBe(0);
    });

    it('con otra clave o propósito no descifra', () => {
      const sealed = sealBytes(KEY, 'files', foto);
      expect(() => openBytes(randomBytes(32), 'files', sealed)).toThrow();
      expect(() => openBytes(KEY, 'smtp-password', sealed)).toThrow();
    });

    it('detecta un byte alterado en cualquier parte', () => {
      const sealed = sealBytes(KEY, 'files', foto);
      for (const pos of [5, 20, 40, sealed.length - 1]) {
        const roto = Buffer.from(sealed);
        roto[pos] ^= 0xff;
        expect(() => openBytes(KEY, 'files', roto)).toThrow();
      }
    });

    it('rechaza un archivo truncado o con otro formato', () => {
      expect(() => openBytes(KEY, 'files', Buffer.from('corto'))).toThrow(/formato desconocido/);
      expect(() => openBytes(KEY, 'files', Buffer.alloc(100))).toThrow(/formato desconocido/);
    });
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
