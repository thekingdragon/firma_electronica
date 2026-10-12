/**
 * CARTA DE NOMBRAMIENTO del corredor de seguros (Anexo I de la Res. SBS 809-2019). Es UN tipo de documento más del servicio
 * de firmas: todo lo propio de la carta (sus datos, su plantilla de partida, sus textos, su lectura de plantillas antiguas)
 * vive en esta carpeta, y el núcleo no la importa directamente.
 */
import { z } from 'zod';
import { blockFormSchema } from '../../documents/form-schemas';
import { makeBlocksRenderer } from '../../documents/render-blocks';
import type { DocumentTypeDefinition } from '../definition';
import { blocksFromLegacy } from './legacy';
import { appointmentLetterSeed } from './template';
import { DEFAULT_LETTER_TEXTS } from './texts';

export { DEFAULT_LETTER_TEXTS } from './texts';

const data = z
  .object({
    // Los seguros que se nombran (líneas A, B, C del modelo). NO son números de póliza.
    insurances: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  })
  .strict();

export const appointmentLetter: DocumentTypeDefinition = {
  code: 'APPOINTMENT_LETTER',
  name: 'Carta de nombramiento',
  dataSchema: data,
  defaultTemplate: appointmentLetterSeed,
  resolveContent: (content) => ({ ...content, texts: { ...DEFAULT_LETTER_TEXTS, ...((content.texts as Record<string, string>) ?? {}) } }),
  legacyBlocks: blocksFromLegacy,
  formSchema: (content) => blockFormSchema(content, blocksFromLegacy),
  render: makeBlocksRenderer(blocksFromLegacy),
};
