export interface ImageInfo {
  type: 'jpeg' | 'png';
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 20_000;

/**
 * Identifica una imagen por sus BYTES (no por el nombre ni el Content-Type que declara el cliente) y
 * lee sus dimensiones sin decodificarla. Devuelve null si no es un JPEG o PNG bien formado: lo que
 * llega por la red no es de fiar, y esta es la única puerta para que un archivo entre al documento.
 */
export function imageInfo(buf: Buffer): ImageInfo | null {
  return pngInfo(buf) ?? jpegInfo(buf);
}

function valid(w: number, h: number): boolean {
  return w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE;
}

function pngInfo(buf: Buffer): ImageInfo | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return valid(width, height) ? { type: 'png', mime: 'image/png', width, height } : null;
}

function jpegInfo(buf: Buffer): ImageInfo | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    while (buf[i + 1] === 0xff) i++; // bytes de relleno
    const marker = buf[i + 1];
    // Marcadores sin longitud.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Fin de imagen o inicio de datos antes de haber visto las dimensiones: malformado.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (i + 4 > buf.length) return null;
    const len = buf.readUInt16BE(i + 2);
    // SOFn (excepto DHT=C4, JPG=C8, DAC=CC) llevan alto y ancho.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return valid(width, height) ? { type: 'jpeg', mime: 'image/jpeg', width, height } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}
