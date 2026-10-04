const KEY_STORAGE = 'fes.apiKey';
const REVIEWER_STORAGE = 'fes.reviewer';

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

/** El nombre de quien revisa se recuerda para no escribirlo en cada revisión (el panel aún no tiene usuarios). */
export function loadReviewer(): string {
  try {
    return localStorage.getItem(REVIEWER_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function saveReviewer(name: string): void {
  try {
    localStorage.setItem(REVIEWER_STORAGE, name);
  } catch {
    /* no pasa nada */
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
export type ReviewResult = 'VERIFIED' | 'REJECTED';

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
  review: ReviewResult | null;
  deliveryMode: 'HOST' | 'SERVICE';
}

export type CreateDelivery = { mode: 'HOST' } | { mode: 'SERVICE'; channel: 'EMAIL'; to: string };

export interface CreateRequestBody {
  documentType: string;
  externalRef: string;
  signer: { name: string; documentType: string; documentNumber: string };
  data: { insurances: string[] };
  otp: { channel: 'EMAIL'; to: string };
  delivery: CreateDelivery;
  expiresInHours: number;
}

export interface CreatedRequest {
  id: string;
  reference: string;
  status: RequestStatus;
  signUrl?: string;
  sentTo?: string;
  warnings?: string[];
  expiresAt: string;
}

export interface Evidence {
  requestId: string;
  reference: string;
  status: RequestStatus;
  signedAt: string | null;
  pdfSha256: string | null;
  signer: { name: string; documentType: string; documentNumber: string };
  otp: { verifiedAt: string; attempts: number } | null;
  photo: { width: number; height: number; sha256: string; receivedAt: string | null; deletedAt: string | null } | null;
  challenge: { code: string; issuedAt: string } | null;
  form: { powers?: string[]; observation?: string } | null;
  clauseText: string;
  ip: string | null;
  userAgent: string | null;
  clientInfo: Record<string, unknown> | null;
  review: { result: ReviewResult; reviewedBy: string; note: string | null; reviewedAt: string } | null;
  events: { event: string; at: string; ip: string | null }[];
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
    throw new ApiRequestError(res.status, json?.code ?? 'ERROR', json?.message ?? `Error ${res.status}`, json?.issues ?? []);
  }
  return { data: json as T, status: res.status };
}

/** Archivos (PDF, foto): la clave va en una cabecera, así que no se pueden pedir con un enlace normal. */
async function fetchBlob(path: string, apiKey: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { 'X-Api-Key': apiKey } });
  } catch {
    throw new ApiRequestError(0, 'NETWORK', 'No se pudo conectar con el servicio. Revise que la API esté en marcha.');
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new ApiRequestError(res.status, json?.code ?? 'ERROR', json?.message ?? `Error ${res.status}`);
  }
  return res.blob();
}

export const api = {
  me: (key: string) => call<Me>('GET', '/v1/me', key).then((r) => r.data),
  list: (key: string, status?: RequestStatus) =>
    call<{ items: SignatureRequest[] }>('GET', `/v1/requests${status ? `?status=${status}` : ''}`, key).then((r) => r.data.items),
  get: (key: string, id: string) => call<SignatureRequest>('GET', `/v1/requests/${id}`, key).then((r) => r.data),
  create: (key: string, body: CreateRequestBody, idempotencyKey: string) =>
    call<CreatedRequest>('POST', '/v1/requests', key, body, { 'Idempotency-Key': idempotencyKey }).then((r) => r.data),
  revoke: (key: string, id: string) => call<{ id: string; status: 'REVOKED' }>('POST', `/v1/requests/${id}/revoke`, key, {}).then((r) => r.data),
  evidence: (key: string, id: string) => call<Evidence>('GET', `/v1/requests/${id}/evidence`, key).then((r) => r.data),
  review: (key: string, id: string, body: { result: ReviewResult; reviewedBy: string; note?: string }) =>
    call<{ result: ReviewResult; reviewedAt: string }>('POST', `/v1/requests/${id}/review`, key, body).then((r) => r.data),
  document: (key: string, id: string) => fetchBlob(`/v1/requests/${id}/document`, key),
  photo: (key: string, id: string) => fetchBlob(`/v1/requests/${id}/photo`, key),
};
