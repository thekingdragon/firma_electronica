import { getDocumentType } from '../document-types';
import type { RenderInput } from './types';

export class UnsupportedDocumentTypeError extends Error {
  constructor(documentType: string) {
    super(`No hay generador de documento para el tipo ${documentType}.`);
    this.name = 'UnsupportedDocumentTypeError';
  }
}

/**
 * El contenido de la plantilla con lo que falte completado con los textos de partida de su tipo de documento. Lo usan el
 * generador del PDF y la página de firma, para que ambos muestren EXACTAMENTE la misma redacción.
 */
export function resolveContent(documentType: string, content: Record<string, unknown>): Record<string, unknown> {
  return getDocumentType(documentType)?.resolveContent?.(content) ?? content;
}

/** Genera el PDF con el generador del tipo de documento. */
export function renderDocument(documentType: string, input: RenderInput): Promise<Uint8Array> {
  const definition = getDocumentType(documentType);
  if (!definition) throw new UnsupportedDocumentTypeError(documentType);
  return definition.render(input);
}
