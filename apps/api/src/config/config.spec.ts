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

  it('WEBHOOK_ALLOW_PRIVATE funciona en desarrollo y se niega en producción', () => {
    expect(loadConfig({ ...base, WEBHOOK_ALLOW_PRIVATE: 'true' }).webhookAllowPrivate).toBe(true);
    expect(loadConfig(base).webhookAllowPrivate).toBe(false);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', WEBHOOK_ALLOW_PRIVATE: 'true' })).toThrow(
      /WEBHOOK_ALLOW_PRIVATE/,
    );
  });

  it('las tareas en segundo plano están activas por defecto y se pueden apagar', () => {
    expect(loadConfig(base).backgroundJobs).toBe(true);
    expect(loadConfig({ ...base, BACKGROUND_JOBS: 'false' }).backgroundJobs).toBe(false);
    expect(() => loadConfig({ ...base, BACKGROUND_JOBS: '0' })).toThrow();
  });

  it('el límite por IP tiene un valor por defecto y acepta solo enteros positivos', () => {
    expect(loadConfig(base).publicRateLimitPerMin).toBe(60);
    expect(loadConfig({ ...base, PUBLIC_RATE_LIMIT_PER_MIN: '10' }).publicRateLimitPerMin).toBe(10);
    expect(() => loadConfig({ ...base, PUBLIC_RATE_LIMIT_PER_MIN: '0' })).toThrow();
  });

  it('WEB_DIST_DIR es opcional y se resuelve a ruta absoluta', () => {
    expect(loadConfig(base).webDistDir).toBeNull();
    const dir = loadConfig({ ...base, WEB_DIST_DIR: './dist-web' }).webDistDir;
    expect(dir).toMatch(/dist-web$/);
    expect(dir === null ? false : /^([a-zA-Z]:|\/)/.test(dir)).toBe(true);
  });

  it('TRUST_PROXY es un entero chico', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '-1' })).toThrow();
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'x' })).toThrow();
  });
});
