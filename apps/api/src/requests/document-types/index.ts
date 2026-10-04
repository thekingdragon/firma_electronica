import { z } from 'zod';

/**
 * Esquema de `data` por tipo de documento. Agregar un tipo = una entrada acá + una fila en
 * `document_types` + su plantilla. Un tipo sin entrada se rechaza: aceptar `data` sin validar
 * dejaría entrar cualquier cosa a un documento que se firma.
 */
const appointmentLetterData = z
  .object({
    // Los seguros que se nombran (líneas A, B, C del modelo). NO son números de póliza.
    insurances: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  })
  .strict();

export const DOCUMENT_TYPE_DATA_SCHEMAS: Record<string, z.ZodType> = {
  APPOINTMENT_LETTER: appointmentLetterData,
};
