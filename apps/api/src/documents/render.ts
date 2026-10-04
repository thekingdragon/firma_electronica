import { renderAppointmentLetter } from './appointment-letter';
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

export function renderDocument(documentType: string, input: RenderInput): Promise<Uint8Array> {
  const renderer = RENDERERS[documentType];
  if (!renderer) throw new UnsupportedDocumentTypeError(documentType);
  return renderer(input);
}
