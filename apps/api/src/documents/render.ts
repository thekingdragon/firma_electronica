import { DEFAULT_LETTER_TEXTS, renderAppointmentLetter } from './appointment-letter';
import type { DocumentRenderer, RenderInput } from './types';

/** Un generador por tipo de documento. Agregar un tipo = una entrada acá. */
const RENDERERS: Record<string, DocumentRenderer> = {
  APPOINTMENT_LETTER: renderAppointmentLetter,
};

export class UnsupportedDocumentTypeError extends Error {
  constructor(documentType: string) {
    super(`No hay generador de documento para el tipo ${documentType}.`);
    this.name = 'UnsupportedDocumentTypeError';
  }
}

/**
 * El contenido de la plantilla con lo que falte completado con los textos de partida. Lo usan el
 * generador del PDF y la página de firma, para que ambos muestren EXACTAMENTE la misma redacción.
 */
export function resolveContent(documentType: string, content: Record<string, unknown>): Record<string, unknown> {
  if (documentType === 'APPOINTMENT_LETTER') {
    return { ...content, texts: { ...DEFAULT_LETTER_TEXTS, ...((content.texts as Record<string, string>) ?? {}) } };
  }
  return content;
}

export function renderDocument(documentType: string, input: RenderInput): Promise<Uint8Array> {
  const renderer = RENDERERS[documentType];
  if (!renderer) throw new UnsupportedDocumentTypeError(documentType);
  return renderer(input);
}
