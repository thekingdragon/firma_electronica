import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Corredora activa en el flujo actual (AsyncLocalStorage). La fija el interceptor global de cada petición (a partir de
 * la clave de API, de la sesión o del token del enlace de firma) y la leen las consultas del pool de runtime, que se la
 * pasan a PostgreSQL como `app.current_tenant`; las políticas RLS comparan contra esa configuración.
 *
 * Sin contexto, la consulta corre con el tenant vacío y RLS no devuelve ninguna fila: falla cerrado, no abierto.
 */
export interface TenantContext {
  tenantId: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export const currentTenantId = (): string | null => tenantStorage.getStore()?.tenantId ?? null;

/** Ejecuta `fn` (y todo lo que arranque desde ahí, incluso después de responder) en el contexto de esa corredora. */
export function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId }, fn);
}
