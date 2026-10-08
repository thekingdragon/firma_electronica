import { z } from 'zod';
import { powersBlockOf, resolveBlocks } from './blocks';

/**
 * Esquema de lo que el firmante completa (`form`), por tipo de documento, construido desde la
 * plantilla del tenant. Lo que el firmante envía se valida contra esto: nada de lo que llega entra
 * al documento sin pasar por acá.
 */
export interface FormValue {
  powers: string[];
  observation: string;
}

export function formSchemaFor(documentType: string, content: Record<string, unknown>): z.ZodType<FormValue> | null {
  if (documentType !== 'APPOINTMENT_LETTER') return null;

  // El formulario sale del bloque de facultades de la plantilla (si no tiene, no hay nada que completar).
  let block;
  try {
    block = powersBlockOf(resolveBlocks(content, null));
  } catch {
    return null;
  }
  const codes = (block?.items ?? []).map((p) => p.code);
  const observationOn = block ? block.observation.enabled : false;
  const maxLen = observationOn ? (block?.observation.maxLength ?? 1000) : 0;
  const required = block !== null && (codes.length > 0 || observationOn);

  return z
    .object({
      powers: z
        .array(z.string())
        .max(codes.length)
        .refine((list) => list.every((c) => codes.includes(c)), 'Facultad desconocida')
        .refine((list) => new Set(list).size === list.length, 'Facultad repetida'),
      observation: z.string().max(maxLen).default(''),
    })
    .strict()
    .refine((f) => !required || f.powers.length > 0 || f.observation.trim().length > 0, {
      message: observationOn ? 'Seleccione al menos una facultad o indique una observación.' : 'Seleccione al menos una facultad.',
      path: ['powers'],
    }) as unknown as z.ZodType<FormValue>;
}
