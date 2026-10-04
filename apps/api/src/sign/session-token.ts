import { createHmac, timingSafeEqual } from 'node:crypto';

/** Cuánto dura la sesión de firma desde que se verifica el OTP. */
export const SESSION_TTL_SECONDS = 30 * 60;

interface Payload {
  /** id de la solicitud */
  r: string;
  /** vencimiento, en segundos desde la época */
  e: number;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function sign(secret: string, payloadB64: string): string {
  return b64u(createHmac('sha256', secret).update(`session:${payloadB64}`).digest());
}

/**
 * Sesión SIN estado: lleva el id de la solicitud y su vencimiento, firmados con HMAC. No hay tabla
 * de sesiones que mantener ni limpiar. Lo que sí se revisa en cada uso, contra la base, es que la
 * solicitud siga PENDING: revocarla corta la sesión aunque el token no haya vencido.
 */
export function issueSessionToken(secret: string, requestId: string, now = Date.now()): { token: string; expiresAt: Date } {
  const e = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = b64u(JSON.stringify({ r: requestId, e } satisfies Payload));
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt: new Date(e * 1000) };
}

/** `true` solo si la firma es válida, no venció y es de ESA solicitud. */
export function verifySessionToken(secret: string, token: string, requestId: string, now = Date.now()): boolean {
  const [payloadB64, sig, extra] = token.split('.');
  if (!payloadB64 || !sig || extra !== undefined) return false;

  const expected = Buffer.from(sign(secret, payloadB64));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;

  try {
    const p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Payload;
    return p.r === requestId && typeof p.e === 'number' && p.e > Math.floor(now / 1000);
  } catch {
    return false;
  }
}
