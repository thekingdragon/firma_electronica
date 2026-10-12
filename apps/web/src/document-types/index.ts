import { appointmentLetterUi } from './appointment-letter';
import type { DocumentTypeUi } from './types';

export type { DocumentTypeUi, Draft } from './types';

/** Los tipos de documento que el panel sabe mostrar y crear. Un tipo desconocido se muestra con su código, sin romper nada. */
const TYPES: readonly DocumentTypeUi[] = [appointmentLetterUi];

export const listDocumentTypeUis = (): readonly DocumentTypeUi[] => TYPES;
export const getDocumentTypeUi = (code: string): DocumentTypeUi | undefined => TYPES.find((t) => t.code === code);
export const documentTypeName = (code: string): string => getDocumentTypeUi(code)?.name ?? code;
