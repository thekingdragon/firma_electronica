import { z } from 'zod';
import { parseSecretsKey } from '../common/secret-box';

export const APP_CONFIG = 'APP_CONFIG';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.string().default('development'),
  // Deriva el token de cada link de firma y los hashes de OTP (HMAC). Si se filtra, se pueden
  // recalcular todos los links: tratarlo como un secreto de primer nivel y no cambiarlo con
  // solicitudes PENDING vivas.
  TOKEN_SECRET: z.string().min(32, 'TOKEN_SECRET debe tener al menos 32 caracteres'),
  // Base pública de la página de firma; el link es `${PUBLIC_BASE_URL}/s/${token}`.
  PUBLIC_BASE_URL: z.url(),
  // Clave maestra para cifrar contraseñas SMTP y archivos. Opcional para arrancar, pero sin ella no
  // se pueden guardar credenciales de correo ni archivos cifrados.
  SECRETS_KEY: z.string().optional(),
  // SOLO DESARROLLO: si el tenant no tiene correo configurado, el OTP no se envía y se devuelve en la
  // respuesta. Es un agujero total en producción, así que el arranque se niega a combinarlo con
  // NODE_ENV=production.
  ALLOW_DEV_OTP: bool,
  // Saltos de proxy delante de la API (p. ej. 1 con el túnel de Cloudflare). Sin esto la IP que se
  // guarda como evidencia sería la del proxy, no la del firmante.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).optional(),
});

export type AppConfig = {
  databaseUrl: string;
  port: number;
  isProduction: boolean;
  tokenSecret: string;
  publicBaseUrl: string;
  secretsKey: Buffer | null;
  allowDevOtp: boolean;
  trustProxy: number | null;
};

/** Lee y valida el entorno. Falla al arrancar, no en la primera petición. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${detalle}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  if (isProduction && e.ALLOW_DEV_OTP) {
    throw new Error('ALLOW_DEV_OTP=true no se puede usar con NODE_ENV=production.');
  }
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    isProduction,
    tokenSecret: e.TOKEN_SECRET,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    secretsKey: e.SECRETS_KEY ? parseSecretsKey(e.SECRETS_KEY) : null,
    allowDevOtp: e.ALLOW_DEV_OTP,
    trustProxy: e.TRUST_PROXY ?? null,
  };
}
