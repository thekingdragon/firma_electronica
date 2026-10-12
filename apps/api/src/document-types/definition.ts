import type { z } from 'zod';
import type { LegacyBlocksReader } from '../documents/blocks';
import type { FormValue } from '../documents/form-schemas';
import type { DocumentRenderer } from '../documents/types';

/** La plantilla con que nace cada corredora para un tipo de documento. */
export interface TemplateSeed {
  documentType: string;
  bodyJson: Record<string, unknown>;
  annexText: string | null;
  clauseText: string;
  otpRequired: boolean;
  photoRequired: boolean;
  photoChallengeRequired: boolean;
  /** Segunda foto, la del documento de identidad (exige photoRequired). */
  idPhotoRequired: boolean;
  /** Reverso del documento de identidad (exige idPhotoRequired). */
  idPhotoBackRequired: boolean;
  /** El firmante recibe su copia solo cuando alguien de la corredora verifica su identidad. */
  reviewRequired: boolean;
}

/**
 * Un TIPO DE DOCUMENTO que el servicio de firmas sabe firmar (la carta de nombramiento es el primero). El núcleo (solicitudes,
 * OTP, evidencia, sello, panel) no conoce ninguno en particular: solo trabaja con esta forma. Agregar un tipo = una carpeta
 * en `document-types/`, su entrada en `index.ts` y una fila en `document_types` (migración).
 */
export interface DocumentTypeDefinition {
  /** Código estable, en MAYÚSCULAS (`APPOINTMENT_LETTER`): es lo que el host manda en `documentType`. */
  code: string;
  /** Nombre para mostrar. */
  name: string;
  /** Valida `data` de la solicitud. Aceptarlo sin validar dejaría entrar cualquier cosa a un documento que se firma. */
  dataSchema: z.ZodType;
  /** La plantilla con que se crea la corredora. */
  defaultTemplate(): TemplateSeed;
  /** Completa el contenido de la plantilla con los textos de partida del tipo (la página de firma y el PDF muestran lo mismo). */
  resolveContent?(content: Record<string, unknown>): Record<string, unknown>;
  /** Lee plantillas guardadas antes de existir los bloques, si este tipo las tuvo. */
  legacyBlocks?: LegacyBlocksReader;
  /** Lo que el firmante completa, sacado de la plantilla; `null` si el tipo no pide nada. */
  formSchema(content: Record<string, unknown>): z.ZodType<FormValue> | null;
  /** Genera el PDF. */
  render: DocumentRenderer;
}
