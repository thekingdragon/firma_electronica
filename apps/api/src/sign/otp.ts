import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Reglas del OTP. Un solo sitio para que el servicio y las pruebas hablen de los mismos números. */
export const OTP_POLICY = {
  /** Vigencia del código. */
  ttlSeconds: 10 * 60,
  /** Intentos de adivinarlo antes de bloquearlo (hay que pedir uno nuevo). 6 dígitos = 1 en 1.000.000. */
  maxAttempts: 5,
  /** Espera mínima entre dos envíos para la misma solicitud. */
  cooldownSeconds: 60,
  /** Tope de envíos por solicitud en una hora (limita el spam al buzón del firmante). */
  maxSendsPerHour: 5,
} as const;

/** Código de 6 dígitos con CSPRNG (no Math.random), con ceros a la izquierda. */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Lo que se guarda del código: un HMAC ligado al id del desafío, no el código. Con 6 dígitos un hash
 * simple se revertiría en milisegundos; con HMAC y secreto del servidor, quien robe solo la base no
 * puede calcularlo. El tope de intentos protege del ataque en línea.
 */
export function hashOtp(secret: string, challengeId: string, code: string): string {
  return createHmac('sha256', secret).update(`otp:${challengeId}:${code}`).digest('hex');
}

export function otpMatches(secret: string, challengeId: string, code: string, storedHash: string): boolean {
  const a = Buffer.from(hashOtp(secret, challengeId, code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** «ana@example.com» → «a**@example.com»: confirma al firmante dónde se envió sin exponer la dirección. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`;
}
