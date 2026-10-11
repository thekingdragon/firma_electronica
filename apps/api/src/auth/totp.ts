import * as crypto from 'node:crypto';

/**
 * TOTP (RFC 6238) y su base32 (RFC 4648), a mano y sin dependencias.
 *
 * POR QUÉ NO UNA LIBRERÍA
 *
 * Lo habitual aquí es `otplib`, y se descartó por dos razones concretas: son unas
 * cuarenta líneas de HMAC y aritmética —el algoritmo lleva especificado y
 * congelado desde 2011, no va a cambiar—, y esto vive en el camino de
 * autenticación, que es donde menos apetece arrastrar un árbol de paquetes de
 * terceros. La contrapartida honesta es que el código de abajo tiene que estar
 * bien: por eso `totp.spec.ts` lo contrasta contra los vectores de prueba
 * publicados en los propios RFC, que es una comprobación más fuerte que «funciona
 * con mi teléfono».
 *
 * SHA-1 y no SHA-256. No es un descuido: es lo que implementan Google
 * Authenticator, Microsoft Authenticator, 1Password y Authy. El parámetro
 * `algorithm` del URI `otpauth://` lo ignoran varias de ellas en silencio, así que
 * anunciar SHA-256 produce códigos que no coinciden y nadie entiende por qué.
 * SHA-1 dentro de HMAC no está afectado por las colisiones que lo retiraron de las
 * firmas: HMAC-SHA1 sigue siendo seguro para esto.
 */

/** Duración de cada código, en segundos. Lo que esperan todas las aplicaciones. */
export const STEP_SECONDS = 30;

/** Dígitos del código. Seis, por la misma razón que SHA-1. */
export const DIGITS = 6;

/**
 * Tolerancia, en pasos hacia atrás y hacia delante.
 *
 * Uno (±30 s) cubre el desfase de reloj de un teléfono normal y el tiempo que
 * tarda alguien en teclear un código que estaba a punto de caducar. Subirlo a dos
 * o tres suena inofensivo, pero multiplica los códigos válidos a la vez —que es
 * exactamente lo que un ataque de fuerza bruta necesita— para arreglar un reloj
 * mal puesto, que se arregla poniendo bien el reloj.
 */
export const WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Codifica en base32 SIN relleno: es como lo esperan los URI `otpauth://`. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodifica base32. Tolera minúsculas, espacios y relleno: el secreto se copia
 *  y pega a mano cuando la cámara no lee el código QR. */
export function base32Decode(input: string): Buffer {
  const limpio = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of limpio) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Carácter inválido en base32: «${ch}»`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Semilla nueva. 20 bytes = 160 bits, el tamaño del bloque de SHA-1 y lo que
 *  recomienda el RFC 4226; también es lo que emiten Google y GitHub. */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** HOTP (RFC 4226): el código de un contador concreto. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(buf).digest();
  // Truncado dinámico: los 4 bits bajos del último byte eligen desde dónde se leen
  // los 4 bytes que forman el número. El 0x7f borra el bit de signo, para que el
  // resultado sea el mismo en lenguajes sin enteros sin signo.
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** El paso (ventana de 30 s) al que pertenece un instante dado. */
export function stepFor(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/**
 * Verifica un código y devuelve el PASO en que encajó, o `null`.
 *
 * Devuelve el paso y no un booleano a propósito: quien llama tiene que guardarlo
 * para impedir que el mismo código sirva otra vez dentro de su ventana. Un
 * `boolean` haría imposible esa protección sin recalcularla fuera.
 *
 * `minStep` descarta los pasos ya consumidos: si el último aceptado fue el N, un
 * código del N o anterior se rechaza aunque el HMAC cuadre.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { minStep?: number | null; atMs?: number; window?: number } = {},
): number | null {
  const limpio = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(limpio)) return null;

  const secret = base32Decode(secretBase32);
  const actual = stepFor(opts.atMs);
  const ventana = opts.window ?? WINDOW;

  for (let delta = -ventana; delta <= ventana; delta++) {
    const paso = actual + delta;
    if (opts.minStep != null && paso <= opts.minStep) continue;
    // Comparación en tiempo constante: comparar códigos con === filtra, por el
    // tiempo que tarda en fallar, cuántos dígitos iniciales acertó quien prueba.
    const esperado = Buffer.from(hotp(secret, paso));
    const recibido = Buffer.from(limpio);
    if (esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido)) {
      return paso;
    }
  }
  return null;
}

/**
 * URI `otpauth://` que se convierte en el código QR.
 *
 * La etiqueta lleva `Emisor:correo` y ADEMÁS el parámetro `issuer`. Es
 * redundante a propósito: hay aplicaciones que solo leen uno de los dos, y sin él
 * la cuenta aparece en la lista sin nombre — que es un problema real para quien
 * tiene ocho entradas y ninguna dice de qué son.
 */
export function otpauthUri(secretBase32: string, email: string, issuer = 'Firma electrónica'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** El secreto en grupos de cuatro, para teclearlo a mano sin perder la cuenta. */
export function formatSecretForHuman(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, '$1 ').trim();
}
