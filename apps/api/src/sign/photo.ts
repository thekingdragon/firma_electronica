import { randomInt } from 'node:crypto';
import type { ImageInfo } from '../documents/image-info';

/** Reglas de la foto de verificación y de su desafío. Un solo sitio para código y pruebas. */
export const PHOTO_POLICY = {
  /** Vigencia del código del desafío. Pensada para conexiones lentas de provincias. */
  challengeTtlSeconds: 10 * 60,
  /** Desafíos que se pueden emitir por solicitud en una hora (cada uno reemplaza al anterior). */
  maxChallengesPerHour: 10,
  maxBytes: 8 * 1024 * 1024,
  /**
   * Selfie: el firmante la toma recortada en vertical (4:5, solo la cabeza y el papel con el número), así que de
   * una cámara de laptop de 720p sale de ~553×691. Se mide la foto GUARDADA, no el cuadro de la cámara: basta para
   * que quien revisa vea el rostro y el número. Es un piso, no la meta.
   */
  minLongSide: 640,
  minShortSide: 540,
  /**
   * Foto del documento: el firmante la toma recortada al marco de un DNI, así que sale con menos píxeles
   * que el cuadro completo de la cámara. Se pide algo menor, pero todavía legible (≈1000 px de ancho).
   */
  idMinLongSide: 1000,
  idMinShortSide: 600,
} as const;

/** Código de 4 dígitos con CSPRNG, con ceros a la izquierda. */
export function generateChallengeCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/** `null` si la resolución alcanza; si no, el motivo para mostrarle al firmante. */
export function checkResolution(info: Pick<ImageInfo, 'width' | 'height'>, kind: 'selfie' | 'id' = 'selfie'): string | null {
  const long = Math.max(info.width, info.height);
  const short = Math.min(info.width, info.height);
  const minLong = kind === 'id' ? PHOTO_POLICY.idMinLongSide : PHOTO_POLICY.minLongSide;
  const minShort = kind === 'id' ? PHOTO_POLICY.idMinShortSide : PHOTO_POLICY.minShortSide;
  if (long >= minLong && short >= minShort) return null;
  return (
    `La foto es muy pequeña (${info.width}×${info.height}). Debe tener al menos ${minShort} px en el lado corto ` +
    `y ${minLong} px en el largo para que se vea con claridad.`
  );
}
