/**
 * La cookie del refresh token, en un solo sitio.
 *
 * Vivía dentro de `auth.controller.ts` y se sacó aquí cuando el segundo factor
 * añadió un camino más que emite sesión (`/auth/mfa/verify`): duplicar las
 * opciones era la forma de que un día `secure` o `sameSite` quedaran distintos
 * según por dónde hubiera entrado la persona, y ese tipo de diferencia no da la
 * cara hasta que alguien no puede mantener la sesión y nadie sabe por qué.
 *
 * El refresh (7 días, la credencial durable) viaja en cookie HttpOnly:
 * inaccesible para JavaScript, así un XSS no puede robar la sesión persistente.
 * Same-origin (Vite proxya /v1) → SameSite=Strict cubre CSRF sin token extra.
 */
export const REFRESH_COOKIE = 'refresh_token';
export const REFRESH_COOKIE_PATH = '/v1/auth';

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    // Secure solo bajo HTTPS: en prod siempre; en dev/local (http) se puede
    // desactivar. COOKIE_SECURE fuerza el valor cuando se sirve por HTTPS (Cloudflare).
    secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: REFRESH_COOKIE_PATH,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
  };
}

export function readCookie(req: any, name: string): string | undefined {
  const raw = req?.headers?.cookie;
  if (!raw) return undefined;
  for (const part of String(raw).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}
