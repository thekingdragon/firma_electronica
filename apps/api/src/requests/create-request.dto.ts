import { z } from 'zod';

export const CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Canales con proveedor implementado. SMS y WhatsApp están en el contrato pero todavía no tienen
 * proveedor: se rechazan con un error claro en vez de aceptarlos y no enviar nada.
 */
export const AVAILABLE_CHANNELS: readonly Channel[] = ['EMAIL'];

const channel = z.enum(CHANNELS);

/** Cuerpo de `POST /v1/requests`. `.strict()`: un campo desconocido es un error, no se ignora. */
export const createRequestSchema = z
  .object({
    documentType: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Código de tipo de documento inválido'),
    externalRef: z.string().trim().min(1).max(200),
    signer: z
      .object({
        name: z.string().trim().min(2).max(200),
        documentType: z.string().trim().min(1).max(30),
        documentNumber: z.string().trim().min(1).max(30),
      })
      .strict(),
    // Datos propios del tipo de documento: se validan aparte contra el esquema del tipo.
    data: z.record(z.string(), z.unknown()),
    otp: z
      .object({ channel, to: z.string().trim().min(3).max(255) })
      .strict()
      .optional(),
    delivery: z
      .object({
        mode: z.enum(['SERVICE', 'HOST']),
        channel: channel.optional(),
        to: z.string().trim().min(3).max(255).optional(),
      })
      .strict(),
    expiresInHours: z.number().int().min(1).max(168).default(48),
    webhookUrl: z.url().max(2000).optional(),
  })
  .strict();

export type CreateRequestInput = z.infer<typeof createRequestSchema>;

/** Valida que el destino tenga la forma que pide su canal. */
export function isValidContact(channelName: Channel, to: string): boolean {
  if (channelName === 'EMAIL') return z.email().safeParse(to).success;
  // SMS y WhatsApp: formato internacional E.164.
  return /^\+[1-9]\d{7,14}$/.test(to);
}
