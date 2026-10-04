/** Cliente de la API PÚBLICA de firma (`/v1/sign/:token/*`). No usa clave de API: va con el token del link y la sesión. */

export class SignApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface SignIntro {
  reference: string;
  documentType: string;
  issuer: { name: string };
  otpRequired: boolean;
  otpTo: string | null;
  expiresAt: string;
}

export interface PowerDef {
  code: string;
  text: string;
  defaultChecked?: boolean;
}

export interface SigningView {
  reference: string;
  documentType: string;
  issuer: { legalName: string; registryCode: string | null };
  signer: { name: string; documentType: string; documentNumber: string };
  data: { insurances?: string[] } & Record<string, unknown>;
  content: { powers?: PowerDef[]; observation?: { maxLength?: number }; texts?: Record<string, string> };
  annexText: string | null;
  clause: { version: number; text: string };
  policy: { photoRequired: boolean; photoChallengeRequired: boolean };
  expiresAt: string;
}

export interface Verified {
  sessionToken: string;
  expiresAt: string;
  view: SigningView;
}

export interface Challenge {
  challengeId: string;
  code: string;
  expiresAt: string;
}

export interface SubmitResult {
  reference: string;
  signedAt: string;
  pdfSha256: string;
  /** El servidor confirma que enviará la copia por correo; no se deduce del OTP. */
  emailed: boolean;
}

async function request<T>(
  method: 'GET' | 'POST',
  token: string,
  path: string,
  opts: { session?: string; json?: unknown; form?: FormData; blob?: boolean } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/v1/sign/${encodeURIComponent(token)}${path}`, {
      method,
      headers: {
        ...(opts.session ? { 'X-Session': opts.session } : {}),
        ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
    });
  } catch {
    throw new SignApiError(0, 'NETWORK', 'No hay conexión con el servicio. Revise su internet e intente de nuevo.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const { code, message, ...extra } = (body ?? {}) as Record<string, unknown>;
    throw new SignApiError(
      res.status,
      typeof code === 'string' ? code : res.status === 413 ? 'TOO_LARGE' : 'ERROR',
      typeof message === 'string' ? message : res.status === 413 ? 'La foto pesa demasiado.' : `Error ${res.status}`,
      extra,
    );
  }
  return (opts.blob ? await res.blob() : await res.json()) as T;
}

export const signApi = {
  intro: (token: string) => request<SignIntro>('GET', token, ''),
  requestOtp: (token: string) =>
    request<{ sentTo: string; cooldownSeconds: number; devCode?: string }>('POST', token, '/otp'),
  verify: (token: string, code?: string) => request<Verified>('POST', token, '/verify', { json: code ? { code } : {} }),
  view: (token: string, session: string) => request<SigningView>('GET', token, '/view', { session }),
  photoChallenge: (token: string, session: string) => request<Challenge>('POST', token, '/photo-challenge', { session }),
  submit: (token: string, session: string, form: FormData) => request<SubmitResult>('POST', token, '/submit', { session, form }),
  document: (token: string, session: string) => request<Blob>('GET', token, '/document', { session, blob: true }),
};

// --- La sesión sobrevive a recargar la página (pero no a cerrar la pestaña) ---

const key = (token: string) => `fes.sign.${token.slice(0, 16)}`;

export function loadSession(token: string): string | null {
  try {
    return sessionStorage.getItem(key(token));
  } catch {
    return null;
  }
}

export function saveSession(token: string, session: string | null): void {
  try {
    if (session) sessionStorage.setItem(key(token), session);
    else sessionStorage.removeItem(key(token));
  } catch {
    /* sin almacenamiento: la sesión dura lo que dure la página */
  }
}
