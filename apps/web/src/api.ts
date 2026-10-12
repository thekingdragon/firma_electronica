import type { Block } from './blocks';

/**
 * El access token de la sesión vive SOLO en memoria (nunca en localStorage: un XSS no puede leerlo de ahí). La sesión
 * durable es la cookie de refresh, HttpOnly. Cuando un 401 indica que el access token venció, se pide uno nuevo con esa
 * cookie y se reintenta una vez; si tampoco se puede renovar, se avisa a quien maneja la sesión (vuelve al login).
 */
let accessToken: string | null = null;
let refresher: (() => Promise<boolean>) | null = null;
export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const setSessionRefresher = (fn: (() => Promise<boolean>) | null) => {
  refresher = fn;
};

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

/** Verificación de punta a punta de una firma: PDF, sello de integridad, sello de tiempo y bitácora (se recalcula al pedirla). */
export interface Integrity {
  ok: boolean;
  pdfIntact: boolean;
  seal: { present: boolean; valid: boolean; coversWholeFile: boolean; certificateSha256: string | null; matchesRecord: boolean };
  timestamp: { present: boolean; valid: boolean; at: string | null };
  chain: { ok: boolean; events: number; head: string | null; brokenAt: number | null };
  problems: string[];
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
  idPhoto: { width: number; height: number; sha256: string; receivedAt: string | null; deletedAt: string | null } | null;
  idPhotoBack: { width: number; height: number; sha256: string; receivedAt: string | null; deletedAt: string | null } | null;
  integrity: Integrity;
  challenge: { code: string; issuedAt: string } | null;
  form: { powers?: string[]; observation?: string } | null;
  clauseText: string;
  ip: string | null;
  userAgent: string | null;
  clientInfo: Record<string, unknown> | null;
  review: { result: ReviewResult; reviewedBy: string; note: string | null; reviewedAt: string } | null;
  events: { event: string; at: string; ip: string | null }[];
}

/** Hace la petición con el token vigente; ante un 401 de sesión, renueva y reintenta UNA vez. */
async function send(path: string, init: RequestInit, retried = false): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { ...(init.headers as Record<string, string>), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) } });
  } catch {
    throw new ApiRequestError(0, 'NETWORK', 'No se pudo conectar con el servicio. Revise que la API esté en marcha.');
  }
  if (res.status === 401 && !retried && refresher && accessToken) {
    const clone = await res.clone().json().catch(() => null);
    if (clone?.code === 'INVALID_SESSION' && (await refresher())) return send(path, init, true);
  }
  return res;
}

async function call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ data: T; status: number }> {
  const res = await send(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiRequestError(res.status, json?.code ?? 'ERROR', json?.message ?? `Error ${res.status}`, json?.issues ?? []);
  }
  return { data: json as T, status: res.status };
}

export interface TemplatePolicy {
  otpRequired: boolean;
  photoRequired: boolean;
  photoChallengeRequired: boolean;
  idPhotoRequired: boolean;
  idPhotoBackRequired: boolean;
  reviewRequired: boolean;
}

export interface TemplateVersionSummary {
  version: number;
  active: boolean;
  createdAt: string;
  publishedBy: string | null;
  legalReviewed: boolean;
}

export interface TemplateListItem {
  documentType: string;
  name: string;
  activeVersion: number;
  legalReviewed: boolean;
  updatedAt: string;
  publishedBy: string | null;
}

export interface TemplateDetail extends TemplateVersionSummary {
  documentType: string;
  name: string;
  legacy: boolean;
  blocks: Block[];
  clauseText: string;
  policy: TemplatePolicy;
  variables: Array<{ name: string; label: string }>;
  versions: TemplateVersionSummary[];
}

export interface PublishTemplateBody {
  blocks: Block[];
  clauseText: string;
  policy: TemplatePolicy;
  legalReviewed: boolean;
  publishedBy: string;
}

/** Archivos (PDF, foto): el token va en una cabecera, así que no se pueden pedir con un enlace normal. */
async function fetchBlob(path: string): Promise<Blob> {
  const res = await send(path, {});
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new ApiRequestError(res.status, json?.code ?? 'ERROR', json?.message ?? `Error ${res.status}`);
  }
  return res.blob();
}

/** POST que devuelve un archivo (la vista previa del PDF). Los errores de validación traen su detalle. */
async function postForBlob(path: string, body: unknown): Promise<Blob> {
  const res = await send(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new ApiRequestError(res.status, json?.code ?? 'ERROR', json?.message ?? `Error ${res.status}`, json?.issues ?? []);
  }
  return res.blob();
}

export const api = {
  list: (status?: RequestStatus) =>
    call<{ items: SignatureRequest[] }>('GET', `/v1/requests${status ? `?status=${status}` : ''}`).then((r) => r.data.items),
  get: (id: string) => call<SignatureRequest>('GET', `/v1/requests/${id}`).then((r) => r.data),
  create: (body: CreateRequestBody, idempotencyKey: string) =>
    call<CreatedRequest>('POST', '/v1/requests', body, { 'Idempotency-Key': idempotencyKey }).then((r) => r.data),
  revoke: (id: string) => call<{ id: string; status: 'REVOKED' }>('POST', `/v1/requests/${id}/revoke`, {}).then((r) => r.data),
  evidence: (id: string) => call<Evidence>('GET', `/v1/requests/${id}/evidence`).then((r) => r.data),
  review: (id: string, body: { result: ReviewResult; reviewedBy: string; note?: string }) =>
    call<{ result: ReviewResult; reviewedAt: string }>('POST', `/v1/requests/${id}/review`, body).then((r) => r.data),
  document: (id: string) => fetchBlob(`/v1/requests/${id}/document`),
  photo: (id: string) => fetchBlob(`/v1/requests/${id}/photo`),
  idPhoto: (id: string) => fetchBlob(`/v1/requests/${id}/id-photo`),
  evidencePackage: (id: string) => fetchBlob(`/v1/requests/${id}/evidence-package`),
  idPhotoBack: (id: string) => fetchBlob(`/v1/requests/${id}/id-photo-back`),
  settings: () => call<{ privacyNotice: string | null; timezone: string }>('GET', '/v1/settings').then((r) => r.data),
  saveSettings: (body: { privacyNotice: string | null; timezone?: string }) =>
    call<{ privacyNotice: string | null; timezone: string }>('PUT', '/v1/settings', body).then((r) => r.data),
  templates: () => call<{ items: TemplateListItem[] }>('GET', '/v1/templates').then((r) => r.data.items),
  template: (type: string, version?: number) =>
    call<TemplateDetail>('GET', version ? `/v1/templates/${type}/versions/${version}` : `/v1/templates/${type}`).then((r) => r.data),
  publishTemplate: (type: string, body: PublishTemplateBody) =>
    call<{ id: string; version: number; previousVersion: number | null }>('POST', `/v1/templates/${type}`, body).then((r) => r.data),
  previewTemplate: (type: string, body: { blocks: Block[]; clauseText: string }) => postForBlob(`/v1/templates/${type}/preview`, body),
};

// ---------------------------------------------------------------------------------------------------------------------
// Sesión del panel (usuarios, segundo factor, recuperación)
// ---------------------------------------------------------------------------------------------------------------------
export type Role = 'OPERATOR' | 'ADMIN' | 'REVIEWER';
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}
export interface AuthTenant {
  name: string;
  legalName: string;
  /** Zona IANA con que se muestran las horas. */
  timezone: string;
}
export interface SessionResponse {
  status: 'ok';
  accessToken: string;
  expiresInSeconds: number;
  user: AuthUser;
  tenant: AuthTenant | null;
}
export type LoginResponse = SessionResponse | { status: 'mfa_required'; pendingToken: string } | { status: 'mfa_setup_required'; pendingToken: string };
export interface TotpSetup {
  qr: string;
  secret: string;
  otpauthUri: string;
}
export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'REVIEWER';
  active: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export const authApi = {
  login: (email: string, password: string) => call<LoginResponse>('POST', '/v1/auth/login', { email, password }).then((r) => r.data),
  mfaVerify: (pendingToken: string, input: { code?: string; recoveryCode?: string }) =>
    call<SessionResponse>('POST', '/v1/auth/mfa/verify', { pendingToken, ...input }).then((r) => r.data),
  setupPending: (pendingToken: string) => call<TotpSetup>('POST', '/v1/auth/mfa/setup-pending', { pendingToken }).then((r) => r.data),
  enablePending: (pendingToken: string, code: string) =>
    call<SessionResponse & { recoveryCodes: string[] }>('POST', '/v1/auth/mfa/enable-pending', { pendingToken, code }).then((r) => r.data),
  /** Renueva con la cookie HttpOnly. Devuelve null si no hay sesión que renovar. */
  refresh: async (): Promise<SessionResponse | null> => {
    try {
      const res = await fetch('/v1/auth/refresh', { method: 'POST' });
      return res.ok ? ((await res.json()) as SessionResponse) : null;
    } catch {
      return null;
    }
  },
  logout: () => fetch('/v1/auth/logout', { method: 'POST' }).then(() => undefined, () => undefined),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<SessionResponse>('POST', '/v1/auth/password/change', { currentPassword, newPassword }).then((r) => r.data),
  resetRequest: (email: string) => call<{ message: string }>('POST', '/v1/auth/password-reset/request', { email }).then((r) => r.data),
  resetComplete: (token: string, newPassword: string) => call<void>('POST', '/v1/auth/password-reset/complete', { token, newPassword }).then(() => undefined),
  mfaSetup: () => call<TotpSetup>('POST', '/v1/auth/mfa/setup', {}).then((r) => r.data),
  mfaEnable: (code: string) => call<{ recoveryCodes: string[] }>('POST', '/v1/auth/mfa/enable', { code }).then((r) => r.data),
  mfaDisable: (password: string, code: string) => call<void>('POST', '/v1/auth/mfa/disable', { password, code }).then(() => undefined),
};

export const usersApi = {
  list: () => call<{ users: ManagedUser[] }>('GET', '/v1/users').then((r) => r.data.users),
  create: (body: { email: string; name: string; role: 'ADMIN' | 'REVIEWER' }) =>
    call<{ id: string; temporaryPassword: string }>('POST', '/v1/users', body).then((r) => r.data),
  update: (id: string, body: { role?: 'ADMIN' | 'REVIEWER'; active?: boolean }) => call<void>('PATCH', `/v1/users/${id}`, body).then(() => undefined),
  resetPassword: (id: string) => call<{ temporaryPassword: string }>('POST', `/v1/users/${id}/reset-password`, {}).then((r) => r.data),
  resetMfa: (id: string) => call<void>('POST', `/v1/users/${id}/reset-mfa`, {}).then(() => undefined),
};

// ---- Panel de operador ----
export interface OperatorOverview {
  service: { database: boolean; storageWritable: boolean; secretsKey: boolean; sealKey: boolean; timestampAuthority: boolean; backgroundJobs: boolean; rlsEnforced: boolean; rlsReason: string | null };
  totals: {
    tenants: number;
    activeTenants: number;
    requests: Record<string, number>;
    signedLast30Days: number;
    timestampsPending: number;
    timestampsGivenUp: number;
    webhooksFailed: number;
    webhooksPending: number;
    mailWithErrors: number;
  };
}
export interface OperatorTenant {
  id: string;
  name: string;
  legalName: string;
  country: string;
  active: boolean;
  createdAt: string;
  mailConfigured: boolean;
  mailLastError: string | null;
  signed: number;
  pending: number;
  lastSignedAt: string | null;
  timestampsPending: number;
  webhooksFailed: number;
  reviewPending: number;
}
export interface VerifyResult {
  checked: number;
  ok: number;
  unsealed: number;
  failed: { requestId: string; reference: string; problems: string[] }[];
}
export interface CreatedTenant {
  tenant: { id: string; name: string };
  apiKey: string;
  webhookSecret: string | null;
  admin: { email: string; temporaryPassword: string } | null;
}

export const operatorApi = {
  overview: () => call<OperatorOverview>('GET', '/v1/operator/overview').then((r) => r.data),
  tenants: () => call<{ tenants: OperatorTenant[] }>('GET', '/v1/operator/tenants').then((r) => r.data.tenants),
  createTenant: (body: { name: string; legalName: string; country: string; timezone?: string; registryCode?: string; adminEmail?: string; adminName?: string }) =>
    call<CreatedTenant>('POST', '/v1/operator/tenants', body).then((r) => r.data),
  setActive: (id: string, active: boolean) => call<{ id: string; active: boolean }>('POST', `/v1/operator/tenants/${id}/active`, { active }).then((r) => r.data),
  verify: (id: string) => call<VerifyResult>('POST', `/v1/operator/tenants/${id}/verify`, {}).then((r) => r.data),
  addAdmin: (id: string, email: string, name: string) =>
    call<{ email: string; temporaryPassword: string }>('POST', `/v1/operator/tenants/${id}/admin`, { email, name }).then((r) => r.data),
};
