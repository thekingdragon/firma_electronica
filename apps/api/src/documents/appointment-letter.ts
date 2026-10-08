/**
 * La carta de nombramiento es un documento más del generador por bloques (ver render-blocks.ts): lo que la
 * distingue es su plantilla de partida, no su código. Este archivo conserva los nombres que ya usaban el
 * resto de módulos y las pruebas.
 */
import { renderBlocksDocument } from './render-blocks';
import type { DocumentRenderer } from './types';

export { DEFAULT_LETTER_TEXTS } from './appointment-letter-texts';

export const renderAppointmentLetter: DocumentRenderer = renderBlocksDocument;
