const KEY_STORAGE = 'fes.apiKey';

/** localStorage puede lanzar (ventana privada, datos bloqueados): la app debe funcionar sin él. */
export function loadApiKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function saveApiKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* sin almacenamiento: la sesión dura lo que dure la pestaña */
  }
}

export interface FieldIssue {
  path: string;
  message: string;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues: FieldIssue[] = [],
  ) {
    super(message);
  }
}

export interface Me {
  name: string;
  country: string;
  legalName: string;
}

export type RequestStatus = 'PENDING' | 'SIGNED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';

export interface SignatureRequest {
  id: string;
  documentType: string;
  reference: string;
  status: RequestStatus;
  signUrl?: string;
  expiresAt: string;
  signedAt: string | null;
  externalRef: string;
  signerName: string;
  data: { insurances?: string[] } & Record<string, unknown>;
  createdAt: string;
}

export interface CreateRequestBody {
  documentType: string;
  externalRef: string;
  signer: { name: string; documentType: string; documentNumber: string };
  data: { insurances: string[] };
  otp: { channel: 'EMAIL'; to: string };
  delivery: { mode: 'HOST' };
  expiresInHours: number;
}

async function call<T>(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ data: T; status: number }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'X-Api-Key': apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiRequestError(0, 'NETWORK', 'No se pudo conectar con el servicio. Revise que la API esté en marcha.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      json?.code ?? 'ERROR',
      json?.message ?? `Error ${res.status}`,
      json?.issues ?? [],
    );
  }
  return { data: json as T, status: res.status };
}

export const api = {
  me: (key: string) => call<Me>('GET', '/v1/me', key).then((r) => r.data),
  list: (key: string, status?: RequestStatus) =>
    call<{ items: SignatureRequest[] }>(
      'GET',
      `/v1/requests${status ? `?status=${status}` : ''}`,
      key,
    ).then((r) => r.data.items),
  get: (key: string, id: string) =>
    call<SignatureRequest>('GET', `/v1/requests/${id}`, key).then((r) => r.data),
  create: (key: string, body: CreateRequestBody, idempotencyKey: string) =>
    call<Pick<SignatureRequest, 'id' | 'reference' | 'status' | 'signUrl' | 'expiresAt'>>(
      'POST',
      '/v1/requests',
      key,
      body,
      { 'Idempotency-Key': idempotencyKey },
    ).then((r) => r.data),
};
