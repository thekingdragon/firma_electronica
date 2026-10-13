import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, api, authApi, setAccessToken, setSessionRefresher } from './api';

type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[] = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sessionError = () => json(401, { code: 'INVALID_SESSION', message: 'La sesión venció.' });
const header = (c: FetchCall, name: string) => (c.init?.headers as Record<string, string> | undefined)?.[name];

function mockFetch(handler: (c: FetchCall, n: number) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const c = { url, init };
      calls.push(c);
      return handler(c, calls.length);
    }),
  );
}

beforeEach(() => {
  setAccessToken(null);
  setSessionRefresher(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('cliente HTTP del panel: sesión', () => {
  it('manda el access token como Bearer, nunca como clave de API', async () => {
    mockFetch(() => json(200, { items: [] }));
    setAccessToken('tok-1');
    await api.list();
    expect(header(calls[0], 'Authorization')).toBe('Bearer tok-1');
    expect(header(calls[0], 'X-Api-Key')).toBeUndefined();
  });

  it('con la sesión vencida renueva UNA vez y reintenta con el token nuevo', async () => {
    mockFetch((c, n) => (n === 1 ? sessionError() : json(200, { items: [{ id: 'a' }] })));
    setAccessToken('viejo');
    const refresher = vi.fn(async () => {
      setAccessToken('nuevo');
      return true;
    });
    setSessionRefresher(refresher);
    const r = await api.list();
    expect(r).toEqual([{ id: 'a' }]);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(header(calls[0], 'Authorization')).toBe('Bearer viejo');
    expect(header(calls[1], 'Authorization')).toBe('Bearer nuevo');
  });

  it('si no se puede renovar, el error llega a la pantalla y NO se reintenta en bucle', async () => {
    mockFetch(() => sessionError());
    setAccessToken('viejo');
    const refresher = vi.fn(async () => false);
    setSessionRefresher(refresher);
    await expect(api.list()).rejects.toMatchObject({ status: 401, code: 'INVALID_SESSION' });
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('si tras renovar sigue fallando con 401, no vuelve a intentar (una sola vez)', async () => {
    mockFetch(() => sessionError());
    setAccessToken('viejo');
    const refresher = vi.fn(async () => true);
    setSessionRefresher(refresher);
    await expect(api.list()).rejects.toBeInstanceOf(ApiRequestError);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('un 401 que NO es de sesión (contraseña incorrecta) no dispara una renovación', async () => {
    mockFetch(() => json(401, { code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos.' }));
    setAccessToken('tok');
    const refresher = vi.fn(async () => true);
    setSessionRefresher(refresher);
    await expect(authApi.login('a@b.com', 'x')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos.' });
    expect(refresher).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('también renueva al descargar archivos (PDF, fotos)', async () => {
    mockFetch((c, n) => (n === 1 ? sessionError() : new Response('%PDF', { status: 200 })));
    setAccessToken('viejo');
    setSessionRefresher(async () => {
      setAccessToken('nuevo');
      return true;
    });
    const blob = await api.document('id-1');
    expect(blob.size).toBe(4);
    expect(header(calls[1], 'Authorization')).toBe('Bearer nuevo');
  });

  it('un corte de red se explica, no se muestra como un error técnico', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.list()).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it('los errores de validación del servidor llegan con su detalle por campo', async () => {
    mockFetch(() => json(422, { code: 'VALIDATION_ERROR', message: 'No válido.', issues: [{ path: 'host', message: 'No se encontró ese servidor.' }] }));
    await expect(api.list()).rejects.toMatchObject({ status: 422, issues: [{ path: 'host', message: 'No se encontró ese servidor.' }] });
  });

  it('la renovación con la cookie devuelve null si no hay sesión (no lanza)', async () => {
    mockFetch(() => sessionError());
    await expect(authApi.refresh()).resolves.toBeNull();
    mockFetch(() => {
      throw new TypeError('sin red');
    });
    await expect(authApi.refresh()).resolves.toBeNull();
  });
});
