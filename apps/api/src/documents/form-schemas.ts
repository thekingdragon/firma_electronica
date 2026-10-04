import { z } from 'zod';

/**
 * Esquema de lo que el firmante completa (`form`), por tipo de documento, construido desde la
 * plantilla del tenant. Lo que el firmante envía se valida contra esto: nada de lo que llega entra
 * al documento sin pasar por acá.
 */
export interface FormValue {
  powers: string[];
  observation: string;
}

interface PowerDef {
  code: string;
}

export function formSchemaFor(documentType: string, content: Record<string, unknown>): z.ZodType<FormValue> | null {
  if (documentType !== 'APPOINTMENT_LETTER') return null;

  const codes = (Array.isArray(content.powers) ? (content.powers as PowerDef[]) : []).map((p) => p.code);
  const maxLen = Number((content.observation as { maxLength?: number } | undefined)?.maxLength ?? 1000);

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
    .refine((f) => f.powers.length > 0 || f.observation.trim().length > 0, {
      message: 'Seleccione al menos una facultad o indique una observación.',
      path: ['powers'],
    }) as unknown as z.ZodType<FormValue>;
}
