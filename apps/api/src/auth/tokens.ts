import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Testigos firmados (JWT HS256) del panel, sin librería: es un HMAC y un par de base64url, y vive en el camino de la
 * autenticación. Se verifica contra los vectores de RFC 7515 en `tokens.spec.ts`.
 *
 * DOS CLAVES DISTINTAS derivadas de TOKEN_SECRET (HKDF con contexto distinto):
 *  - `access`: la sesión corta (15 min) que el panel manda en cada petición.
 *  - `mfa-pending`: el testigo intermedio entre «contraseña correcta» y «segundo factor correcto» (5 min).
 * Con la misma clave, un testigo intermedio sería aceptado como sesión y el segundo factor no valdría nada: es el
 * fallo clásico, y lo evita que ni siquiera compartan firma (además de `typ`).
 */
export type TokenKind = 'access' | 'mfa-pending';

export const ACCESS_MINUTES = 15;
export const PENDING_MINUTES = 5;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signingKey(tokenSecret: string, kind: TokenKind): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(tokenSecret), Buffer.alloc(0), `firma-electronica:jwt:${kind}`, 32));
}

export interface Claims {
  sub: string;
  typ: TokenKind;
  iat: number;
  /** Versión de sesión del usuario al emitirse (solo en 'access'); ver users.session_version. */
  ver?: number;
  exp: number;
  /** Solo en `mfa-pending`: lo que se puede hacer con él. 'verify' = pedir el código; 'setup' = activar el factor. */
  stage?: 'verify' | 'setup';
}

export function signToken(tokenSecret: string, kind: TokenKind, sub: string, minutes: number, extra: { stage?: 'verify' | 'setup'; ver?: number } = {}, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const claims: Claims = { sub, typ: kind, iat, exp: iat + minutes * 60, ...extra };
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(claims));
  const sig = createHmac('sha256', signingKey(tokenSecret, kind)).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Devuelve las claims si la firma, el tipo y la vigencia son correctos; `null` en cualquier otro caso. */
export function verifyToken(tokenSecret: string, kind: TokenKind, token: string, nowMs = Date.now()): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    // Se fija el algoritmo: aceptar el que diga la cabecera es la vulnerabilidad histórica de los JWT (alg=none).
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', signingKey(tokenSecret, kind)).update(`${head}.${body}`).digest();
    const received = Buffer.from(sig, 'base64url');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims;
    if (claims.typ !== kind || typeof claims.sub !== 'string') return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Token opaco aleatorio (refresh, restablecimiento de contraseña): en la base solo se guarda su hash. */
export const newOpaqueToken = (): string => randomBytes(32).toString('hex');
export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');
