import { z } from 'zod';
import { LegacyBlocksReader, consentsOf, powersBlockOf, resolveBlocks } from './blocks';

/**
 * Esquema de lo que el firmante completa (`form`), por tipo de documento, construido desde la
 * plantilla del tenant. Lo que el firmante envía se valida contra esto: nada de lo que llega entra
 * al documento sin pasar por acá.
 */
export interface FormValue {
  powers: string[];
  observation: string;
  /** Códigos de los consentimientos que el firmante marcó. */
  consents: string[];
}

/**
 * El esquema del formulario a partir de los bloques de la plantilla (facultades, observación, consentimientos). Es el mismo
 * motor para todos los tipos de documento; cada uno decide si lo usa (ver document-types).
 */
export function blockFormSchema(content: Record<string, unknown>, legacy?: LegacyBlocksReader): z.ZodType<FormValue> | null {

  // El formulario sale del bloque de facultades de la plantilla (si no tiene, no hay nada que completar).
  let block;
  let consents;
  try {
    const blocks = resolveBlocks(content, null, legacy);
    block = powersBlockOf(blocks);
    consents = consentsOf(blocks);
  } catch {
    return null;
  }
  const consentCodes = consents.map((c) => c.code);
  const consentRequired = consents.filter((c) => c.required).map((c) => c.code);
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
      consents: z
        .array(z.string())
        .max(consentCodes.length)
        .refine((list) => list.every((c) => consentCodes.includes(c)), 'Consentimiento desconocido')
        .refine((list) => new Set(list).size === list.length, 'Consentimiento repetido')
        .default([]),
    })
    .strict()
    .refine((f) => consentRequired.every((c) => f.consents.includes(c)), {
      message: 'Debe aceptar los consentimientos obligatorios.',
      path: ['consents'],
    })
    .refine((f) => !required || f.powers.length > 0 || f.observation.trim().length > 0, {
      message: observationOn ? 'Seleccione al menos una facultad o indique una observación.' : 'Seleccione al menos una facultad.',
      path: ['powers'],
    }) as unknown as z.ZodType<FormValue>;
}
