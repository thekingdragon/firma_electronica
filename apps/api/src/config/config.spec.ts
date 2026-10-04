import { randomBytes } from 'node:crypto';
import { loadConfig } from './config';

const base = {
  DATABASE_URL: 'postgres://x@localhost/db',
  TOKEN_SECRET: 't'.repeat(32),
  PUBLIC_BASE_URL: 'https://firma.example.com/',
};

describe('loadConfig', () => {
  it('lee los valores mínimos y quita la barra final de PUBLIC_BASE_URL', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(4000);
    expect(c.publicBaseUrl).toBe('https://firma.example.com');
    expect(c.secretsKey).toBeNull();
    expect(c.allowDevOtp).toBe(false);
    expect(c.trustProxy).toBeNull();
  });

  it('exige TOKEN_SECRET de 32 caracteres o más', () => {
    expect(() => loadConfig({ ...base, TOKEN_SECRET: 'corto' })).toThrow(/TOKEN_SECRET/);
  });

  it('exige DATABASE_URL y PUBLIC_BASE_URL', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: 'no-es-url' })).toThrow(/PUBLIC_BASE_URL/);
  });

  it('parsea SECRETS_KEY y rechaza una de tamaño incorrecto', () => {
    const key = randomBytes(32);
    expect(loadConfig({ ...base, SECRETS_KEY: key.toString('base64') }).secretsKey?.equals(key)).toBe(true);
    expect(() => loadConfig({ ...base, SECRETS_KEY: 'AAAA' })).toThrow(/32 bytes/);
  });

  it('ALLOW_DEV_OTP funciona en desarrollo', () => {
    expect(loadConfig({ ...base, ALLOW_DEV_OTP: 'true' }).allowDevOtp).toBe(true);
  });

  it('ALLOW_DEV_OTP se niega a arrancar en producción', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', ALLOW_DEV_OTP: 'true' })).toThrow(
      /ALLOW_DEV_OTP/,
    );
  });

  it('ALLOW_DEV_OTP solo acepta true o false', () => {
    expect(() => loadConfig({ ...base, ALLOW_DEV_OTP: 'yes' })).toThrow();
  });

  it('TRUST_PROXY es un entero chico', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '-1' })).toThrow();
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'x' })).toThrow();
  });
});
