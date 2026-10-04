/**
 * El contrato (docs/openapi.yaml) y la API real no pueden desalinearse en silencio: ya pasó varias veces
 * (un endpoint documentado que no existía, un esquema con otra forma). Esta prueba compara las rutas
 * REALES registradas en la aplicación con las del contrato, en los dos sentidos.
 * Requiere TEST_DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp, resetDatabase, testDatabaseUrl } from './test-utils';

const URL_DB = testDatabaseUrl();
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

const clean = (p: string) => p.replace(/^\/+|\/+$/g, '');

/** «GET /v1/requests/{id}»: las rutas de Nest con `:id` pasan al formato de OpenAPI. */
function realRoutes(app: INestApplication): string[] {
  const out = new Set<string>();
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...a: never[]) => unknown) | null;
      if (!ctrl) continue;
      const base = clean(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = (ctrl.prototype as Record<string, unknown>)[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;
        const sub = clean(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        const path = '/' + [base, sub].filter(Boolean).join('/');
        out.add(`${METHODS[method]} ${path.replace(/:([A-Za-z]+)/g, '{$1}')}`);
      }
    }
  }
  return [...out].sort();
}

function documentedRoutes(): string[] {
  const doc = yaml.load(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'openapi.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const out: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const verb of Object.keys(ops)) {
      if (['get', 'post', 'put', 'delete', 'patch'].includes(verb)) out.push(`${verb.toUpperCase()} ${path}`);
    }
  }
  return out.sort();
}

describe('contrato OpenAPI vs API real', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await (await resetDatabase(URL_DB)).end();
    app = await makeApp({ DATABASE_URL: URL_DB, TOKEN_SECRET: 't'.repeat(40), PUBLIC_BASE_URL: 'https://firma.test', NODE_ENV: 'test' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('toda ruta real está documentada', () => {
    const faltan = realRoutes(app).filter((r) => !documentedRoutes().includes(r));
    expect(faltan).toEqual([]);
  });

  it('toda ruta documentada existe (nada prometido que no esté construido)', () => {
    const sobran = documentedRoutes().filter((r) => !realRoutes(app).includes(r));
    expect(sobran).toEqual([]);
  });

  it('descubre las rutas: no pasa «en vacío» porque la lista salió vacía', () => {
    const reales = realRoutes(app);
    expect(reales.length).toBeGreaterThanOrEqual(17);
    expect(reales).toContain('POST /v1/requests/{id}/review');
    expect(reales).toContain('POST /v1/sign/{token}/submit');
  });
});
