/**
 * Plantillas de partida que se le crean a una corredora nueva: una por cada tipo de documento que el servicio firma. Son un
 * punto de partida editable: la corredora puede crear una versión nueva; una versión usada no se edita (ver document_templates).
 * Lo propio de cada tipo vive en `document-types/`.
 */
import { listDocumentTypes, type TemplateSeed } from '../document-types';

export type { TemplateSeed } from '../document-types';

export function defaultTemplates(): TemplateSeed[] {
  return listDocumentTypes().map((d) => d.defaultTemplate());
}
