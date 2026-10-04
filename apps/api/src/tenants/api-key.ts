import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../common/crypto';

const PREFIX = 'fes_';

/** Clave que se entrega UNA vez al crear el tenant. En la base solo se guarda su hash. */
export function generateApiKey(): string {
  return PREFIX + randomBytes(32).toString('base64url');
}

/**
 * SHA-256 sin sal: la clave tiene 256 bits de entropía, así que no hay diccionario que atacar y
 * un hash determinista permite buscar el tenant por índice único. (Esto NO serviría para
 * contraseñas de personas.)
 */
export function hashApiKey(apiKey: string): string {
  return sha256Hex(apiKey);
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(PREFIX) && value.length >= 40 && value.length <= 80;
}
