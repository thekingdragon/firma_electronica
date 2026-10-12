import { appointmentLetter } from './appointment-letter';
import type { DocumentTypeDefinition } from './definition';

export type { DocumentTypeDefinition, TemplateSeed } from './definition';

/**
 * Los tipos de documento que este servicio firma. El núcleo solo pregunta aquí; no importa ninguno directamente.
 * Un tipo sin entrada se rechaza (no hay qué validar ni cómo generar el PDF).
 */
const DEFINITIONS: readonly DocumentTypeDefinition[] = [appointmentLetter];

export const listDocumentTypes = (): readonly DocumentTypeDefinition[] => DEFINITIONS;

export const getDocumentType = (code: string): DocumentTypeDefinition | undefined => DEFINITIONS.find((d) => d.code === code);
