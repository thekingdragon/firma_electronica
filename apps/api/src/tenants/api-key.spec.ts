import { generateApiKey, hashApiKey, looksLikeApiKey } from './api-key';

describe('api-key', () => {
  it('genera claves distintas con el prefijo fes_', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).not.toBe(b);
    expect(a.startsWith('fes_')).toBe(true);
  });

  it('la clave generada pasa looksLikeApiKey', () => {
    expect(looksLikeApiKey(generateApiKey())).toBe(true);
  });

  it('rechaza valores que no tienen forma de clave', () => {
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('fes_corta')).toBe(false);
    expect(looksLikeApiKey('x'.repeat(50))).toBe(false);
    expect(looksLikeApiKey('fes_' + 'a'.repeat(200))).toBe(false);
  });

  it('el hash es estable, de 64 hex y distinto de la clave', () => {
    const k = generateApiKey();
    expect(hashApiKey(k)).toBe(hashApiKey(k));
    expect(hashApiKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(k)).not.toBe(k);
  });
});
