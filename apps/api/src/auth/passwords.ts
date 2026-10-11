import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 10;

/** Reglas mínimas. Largo antes que rarezas: una frase larga vale más que «P@ss1». */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password.length > 200) return 'La contraseña es demasiado larga.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'La contraseña debe combinar letras y números.';
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) {
    return 'La contraseña no puede contener su correo.';
  }
  return null;
}

export const hashPassword = (password: string): Promise<string> => argon2.hash(password, { type: argon2.argon2id });

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Contraseña provisional legible (sin 0/O/1/I/l) para altas y restablecimientos hechos por otra persona. */
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 14; i++) out += alphabet[randomInt(alphabet.length)];
  // Garantiza letras y número para pasar la propia política.
  return `${out.slice(0, 12)}${randomInt(2, 10)}${randomInt(2, 10)}`;
}

/** Hash ficticio para igualar el tiempo cuando el correo no existe (no revelar qué cuentas hay). */
let dummy: Promise<string> | null = null;
export const dummyHash = (): Promise<string> => (dummy ??= hashPassword('contraseña-ficticia-1'));
