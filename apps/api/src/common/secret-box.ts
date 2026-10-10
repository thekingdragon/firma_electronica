import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Cifrado de secretos guardados en la base (contraseñas SMTP) y, más adelante, de archivos.
 *
 * AES-256-GCM, que es *autenticado*: si alguien edita la columna a mano, `openWith` falla en vez de
 * devolver basura. Formato `v1:<iv>:<tag>:<datos>` (base64); el prefijo permite cambiar de
 * algoritmo sabiendo qué hay en cada fila.
 *
 * Se parte de UNA clave maestra (`SECRETS_KEY`) y se deriva una subclave por propósito (HKDF): así
 * un fallo en cómo se usa una no compromete a las otras. Si se pierde la clave maestra, lo cifrado
 * es irrecuperable.
 */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // el tamaño que recomienda GCM
const KEY_BYTES = 32;

export type KeyPurpose = 'smtp-password' | 'files' | 'webhook-secret' | 'seal-key';

/** Acepta base64 o hexadecimal de 32 bytes: es la clase de variable que se copia entre entornos. */
export function parseSecretsKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SECRETS_KEY debe tener ${KEY_BYTES} bytes (llegó con ${key.length}). Generar una con: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

export function deriveKey(masterKey: Buffer, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `firma-electronica:${purpose}`, KEY_BYTES));
}

/** Cifra. IV nuevo en cada llamada: reutilizarlo con la misma clave rompe GCM por completo. */
export function seal(masterKey: Buffer, purpose: KeyPurpose, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(masterKey, purpose), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

const BYTES_MAGIC = Buffer.from('FES1');
const TAG_BYTES = 16;

/**
 * Cifra un archivo. Formato binario: `FES1` + iv (12) + tag (16) + datos. Misma garantía que
 * `seal`: GCM autenticado, IV nuevo por archivo, subclave por propósito.
 */
export function sealBytes(masterKey: Buffer, purpose: KeyPurpose, plain: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(masterKey, purpose), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([BYTES_MAGIC, iv, cipher.getAuthTag(), data]);
}

/** Descifra un archivo. Lanza si fue alterado o si la clave o el propósito no coinciden. */
export function openBytes(masterKey: Buffer, purpose: KeyPurpose, sealed: Buffer): Buffer {
  const head = BYTES_MAGIC.length + IV_BYTES + TAG_BYTES;
  if (sealed.length < head || !sealed.subarray(0, BYTES_MAGIC.length).equals(BYTES_MAGIC)) {
    throw new Error('Archivo cifrado con formato desconocido.');
  }
  const iv = sealed.subarray(BYTES_MAGIC.length, BYTES_MAGIC.length + IV_BYTES);
  const tag = sealed.subarray(BYTES_MAGIC.length + IV_BYTES, head);
  const decipher = createDecipheriv(ALGORITHM, deriveKey(masterKey, purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(head)), decipher.final()]);
}

/** Descifra. Lanza si el valor fue alterado, si la clave o el propósito no son los que lo cifraron. */
export function open(masterKey: Buffer, purpose: KeyPurpose, sealed: string): string {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`Secreto con formato desconocido (se esperaba ${VERSION}:iv:tag:datos).`);
  }
  const [, iv, tag, data] = parts;
  const decipher = createDecipheriv(ALGORITHM, deriveKey(masterKey, purpose), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
