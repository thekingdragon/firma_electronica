import { createHash, createHmac, randomBytes } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Token del link de firma de una solicitud: se DERIVA del id con HMAC en vez de guardarse. Así,
 * si el host repite la creación (idempotencia) o pierde la respuesta, el servicio puede devolver
 * el mismo link sin guardar el token en claro. En la base solo queda `token_hash`.
 */
export function signTokenFor(requestId: string, tokenSecret: string): string {
  return createHmac('sha256', tokenSecret).update(`sign-token:${requestId}`).digest('base64url');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Texto aleatorio legible (sin I, L, O, U) para referencias que una persona puede dictar. */
export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CROCKFORD[bytes[i] % CROCKFORD.length];
  return out;
}
