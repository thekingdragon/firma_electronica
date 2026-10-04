import { randomInt } from 'node:crypto';
import type { ImageInfo } from '../documents/image-info';

/** Reglas de la foto de verificación y de su desafío. Un solo sitio para código y pruebas. */
export const PHOTO_POLICY = {
  /** Vigencia del código del desafío. Pensada para conexiones lentas de provincias. */
  challengeTtlSeconds: 10 * 60,
  /** Desafíos que se pueden emitir por solicitud en una hora (cada uno reemplaza al anterior). */
  maxChallengesPerHour: 10,
  maxBytes: 8 * 1024 * 1024,
  /** Resolución mínima (lado largo × lado corto): suficiente para leer un DNI. Es un piso, no la meta. */
  minLongSide: 1280,
  minShortSide: 720,
} as const;

/** Código de 4 dígitos con CSPRNG, con ceros a la izquierda. */
export function generateChallengeCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/** `null` si la resolución alcanza; si no, el motivo para mostrarle al firmante. */
export function checkResolution(info: Pick<ImageInfo, 'width' | 'height'>): string | null {
  const long = Math.max(info.width, info.height);
  const short = Math.min(info.width, info.height);
  if (long >= PHOTO_POLICY.minLongSide && short >= PHOTO_POLICY.minShortSide) return null;
  return (
    `La foto es muy pequeña (${info.width}×${info.height}). La cámara debe dar al menos ` +
    `${PHOTO_POLICY.minLongSide}×${PHOTO_POLICY.minShortSide} para que se lea el documento.`
  );
}
