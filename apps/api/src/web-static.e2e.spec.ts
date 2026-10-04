/**
 * Pruebas de integración de cómo la API sirve el panel compilado y de las cabeceras de seguridad.
 * Requieren TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDatabase, testDatabaseUrl } from './test-utils';

const URL_DB = testDatabaseUrl();
const INDEX = '<!doctype html><html><head><title>Panel de prueba</title></head><body><div id="root"></div></body></html>';

describe('panel servido por la API', () => {
  let withWeb: INestApplication;
  let withoutWeb: INestApplication;
  let root: string;
  let dist: string;

  const env = () => ({
    DATABASE_URL: URL_DB,
    TOKEN_SECRET: 't'.repeat(40),
    PUBLIC_BASE_URL: 'https://firma.test',
    NODE_ENV: 'test',
  });

  beforeAll(async () => {
    await (await resetDatabase(URL_DB)).end();
    root = await mkdtemp(join(tmpdir(), 'fes-web-'));
    dist = join(root, 'dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), INDEX);
    await writeFile(join(dist, 'assets', 'app-abc123.js'), 'console.log("app")');
    await writeFile(join(dist, 'assets', 'app-abc123.css'), 'body{margin:0}');
    await writeFile(join(root, 'secreto.txt'), 'NO DEBE SALIR DEL DIRECTORIO'); // fuera de dist
    withWeb = await makeApp({ ...env(), WEB_DIST_DIR: dist });
    withoutWeb = await makeApp(env());
  }, 60_000);

  afterAll(async () => {
    await withWeb?.close();
    await withoutWeb?.close();
    await rm(root, { recursive: true, force: true });
  });

  const http = (a = withWeb) => request(a.getHttpServer());

  it('la raíz y las rutas del panel devuelven index.html, que se revalida siempre', async () => {
    for (const path of ['/', '/conectar', '/solicitudes', '/solicitudes/nueva', '/solicitudes/0b3c1f2e-aaaa-bbbb-cccc-1234567890ab']) {
      const r = await http().get(path);
      expect(r.status).toBe(200);
      expect(r.text).toContain('Panel de prueba');
      expect(r.headers['cache-control']).toBe('no-cache');
    }
  });

  it('la página de firma (/s/<token>) la sirve la misma SPA', async () => {
    const r = await http().get(`/s/${'A'.repeat(43)}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('Panel de prueba');
  });

  it('los archivos con hash en el nombre se cachean un año', async () => {
    const js = await http().get('/assets/app-abc123.js');
    expect(js.status).toBe(200);
    expect(js.text).toBe('console.log("app")');
    expect(js.headers['cache-control']).toMatch(/max-age=31536000/);
    expect(js.headers['cache-control']).toMatch(/immutable/);
    expect((await http().get('/assets/app-abc123.css')).status).toBe(200);
  });

  it('un archivo que no existe da 404, NO una página HTML que el navegador intentaría ejecutar', async () => {
    const r = await http().get('/assets/viejo.js');
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('Panel de prueba');
    expect((await http().get('/favicon.ico')).status).toBe(404);
  });

  it('la API no se ve afectada: /v1 responde lo suyo, con no-store, y un /v1 desconocido da 404 de la API', async () => {
    const health = await http().get('/v1/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ database: 'up' });
    expect(health.headers['cache-control']).toBe('no-store');
    const nada = await http().get('/v1/no-existe');
    expect(nada.status).toBe(404);
    expect(nada.text).not.toContain('Panel de prueba');
  });

  it('los métodos que no son GET no caen en la SPA', async () => {
    const r = await http().post('/solicitudes').send({});
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('Panel de prueba');
  });

  it('no se puede salir del directorio del panel (path traversal)', async () => {
    for (const path of ['/assets/..%2f..%2fsecreto.txt', '/..%2fsecreto.txt', '/assets/../../secreto.txt', '/%2e%2e/secreto.txt']) {
      const r = await http().get(path);
      expect(r.text).not.toContain('NO DEBE SALIR');
    }
  });

  it('cabeceras de seguridad: el token en la URL no se filtra y la página no se puede incrustar', async () => {
    const r = await http().get(`/s/${'A'.repeat(43)}`);
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['permissions-policy']).toContain('camera=(self)');
    expect(r.headers['permissions-policy']).toContain('microphone=()');
    const csp = r.headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    // La foto de la cámara se muestra desde un blob: local.
    expect(csp).toMatch(/img-src[^;]*blob:/);
  });

  it('las cabeceras de seguridad también salen en las respuestas de la API', async () => {
    const r = await http().get('/v1/health');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('sin panel compilado la API funciona igual y la raíz da 404 de la API', async () => {
    expect((await http(withoutWeb).get('/v1/health')).status).toBe(200);
    const r = await http(withoutWeb).get('/');
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('Panel de prueba');
  });
});
