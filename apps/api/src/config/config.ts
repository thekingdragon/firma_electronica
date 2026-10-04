import { z } from 'zod';

export const APP_CONFIG = 'APP_CONFIG';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.string().default('development'),
  // Deriva el token de cada link de firma (HMAC). Si se filtra, se pueden recalcular todos los
  // links: tratarlo como un secreto de primer nivel y no cambiarlo con solicitudes PENDING vivas.
  TOKEN_SECRET: z.string().min(32, 'TOKEN_SECRET debe tener al menos 32 caracteres'),
  // Base pública de la página de firma; el link es `${PUBLIC_BASE_URL}/s/<token>`.
  PUBLIC_BASE_URL: z.url(),
});

export type AppConfig = {
  databaseUrl: string;
  port: number;
  isProduction: boolean;
  tokenSecret: string;
  publicBaseUrl: string;
};

/** Lee y valida el entorno. Falla al arrancar, no en la primera petición. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Configuración inválida: ${detalle}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    isProduction: e.NODE_ENV === 'production',
    tokenSecret: e.TOKEN_SECRET,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
  };
}
