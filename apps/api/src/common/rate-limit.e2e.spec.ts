/**
 * Pruebas de integración del límite de peticiones por IP. Requieren TEST_DATABASE_URL.
 * Se usa un límite base BAJO (6/min): otp = 1, verify = 2, submit = 1, challenge = 2, resto = 6.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeApp, resetDatabase, testDatabaseUrl } from '../test-utils';
import { createTenant } from '../tenants/tenants.service';

const URL_DB = testDatabaseUrl();
const TOKEN = 'A'.repeat(43); // un token con formato válido que no existe

describe('límite de peticiones por IP', () => {
  let app: INestApplication;
  let pool: Pool;
  let key: string;

  const http = () => request(app.getHttpServer());
  /** Cada «cliente» es una IP distinta (el servicio confía en 1 salto de proxy). */
  const from = (ip: string) => ({
    get: (path: string) => http().get(path).set('X-Forwarded-For', ip),
    post: (path: string) => http().post(path).set('X-Forwarded-For', ip),
  });

  beforeAll(async () => {
    pool = await resetDatabase(URL_DB);
    key = (await createTenant(pool, { name: 'T', country: 'PE', legalName: 'T SAC' })).apiKey;
    app = await makeApp({
      DATABASE_URL: URL_DB,
      TOKEN_SECRET: 't'.repeat(40),
      PUBLIC_BASE_URL: 'https://firma.test',
      NODE_ENV: 'test',
      TRUST_PROXY: '1',
      PUBLIC_RATE_LIMIT_PER_MIN: '6',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('pasado el cupo responde 429 con RATE_LIMITED y Retry-After', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < 6; i++) expect((await from(ip).get(`/v1/sign/${TOKEN}`)).status).toBe(404);
    const r = await from(ip).get(`/v1/sign/${TOKEN}`);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
    expect(r.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('cada IP tiene su propio cupo: agotar una no afecta a otra', async () => {
    const a = '203.0.113.11';
    const b = '203.0.113.12';
    for (let i = 0; i < 7; i++) await from(a).get(`/v1/sign/${TOKEN}`);
    expect((await from(a).get(`/v1/sign/${TOKEN}`)).status).toBe(429);
    expect((await from(b).get(`/v1/sign/${TOKEN}`)).status).toBe(404);
  });

  it('las acciones caras tienen menos margen: pedir OTP permite 1 por minuto y por IP', async () => {
    const ip = '203.0.113.13';
    // La primera llega al servicio (404 por token inexistente); la segunda ya no pasa del limitador.
    expect((await from(ip).post(`/v1/sign/${TOKEN}/otp`)).status).toBe(404);
    const r = await from(ip).post(`/v1/sign/${TOKEN}/otp`);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
  });

  it('los grupos no se pisan: agotar «otp» no bloquea abrir la página ni verificar', async () => {
    const ip = '203.0.113.14';
    await from(ip).post(`/v1/sign/${TOKEN}/otp`);
    expect((await from(ip).post(`/v1/sign/${TOKEN}/otp`)).status).toBe(429);
    expect((await from(ip).get(`/v1/sign/${TOKEN}`)).status).toBe(404);
    expect((await from(ip).post(`/v1/sign/${TOKEN}/verify`).send({ code: '123456' })).status).toBe(404);
  });

  it('un cliente que insiste con 429 sigue acumulando: no recupera cupo por seguir intentando', async () => {
    const ip = '203.0.113.15';
    for (let i = 0; i < 6; i++) await from(ip).get(`/v1/sign/${TOKEN}`);
    for (let i = 0; i < 5; i++) expect((await from(ip).get(`/v1/sign/${TOKEN}`)).status).toBe(429);
  });

  describe('clave de API', () => {
    it('una clave VÁLIDA no se limita: 50 peticiones seguidas pasan', async () => {
      for (let i = 0; i < 50; i++) {
        const r = await from('203.0.113.20').get('/v1/me').set('X-Api-Key', key);
        expect(r.status).toBe(200);
      }
    });

    it('tras 20 intentos con clave inválida, la IP recibe 429 en vez de 401', async () => {
      const ip = '203.0.113.21';
      for (let i = 0; i < 20; i++) expect((await from(ip).get('/v1/me').set('X-Api-Key', 'fes_' + 'x'.repeat(43))).status).toBe(401);
      const r = await from(ip).get('/v1/me').set('X-Api-Key', 'fes_' + 'y'.repeat(43));
      expect(r.status).toBe(429);
      expect(r.body.code).toBe('RATE_LIMITED');
      expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    });

    it('y esa misma IP, con una clave VÁLIDA, sigue funcionando (no se deja sin servicio a un host legítimo)', async () => {
      const ip = '203.0.113.22';
      for (let i = 0; i < 25; i++) await from(ip).get('/v1/me').set('X-Api-Key', 'fes_' + 'z'.repeat(43));
      expect((await from(ip).get('/v1/me').set('X-Api-Key', 'fes_' + 'z'.repeat(43))).status).toBe(429);
      expect((await from(ip).get('/v1/me').set('X-Api-Key', key)).status).toBe(200);
    });

    it('los intentos fallidos de una IP no afectan a otra', async () => {
      for (let i = 0; i < 22; i++) await from('203.0.113.23').get('/v1/me').set('X-Api-Key', 'fes_' + 'w'.repeat(43));
      expect((await from('203.0.113.24').get('/v1/me').set('X-Api-Key', 'fes_' + 'w'.repeat(43))).status).toBe(401);
    });
  });
});
