import { resolve } from 'node:path';
import { z } from 'zod';
import { parseSecretsKey } from '../common/secret-box';

export const APP_CONFIG = 'APP_CONFIG';

/** `true`/`false` explícitos: «yes», «1» o vacío son errores, no valores por defecto silenciosos. */
const boolean = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true');

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  // Dirección en la que escucha. Por defecto solo esta máquina (detrás del túnel); 0.0.0.0 abre la red local.
  HOST: z.string().min(1).default('127.0.0.1'),
  NODE_ENV: z.string().default('development'),
  // Deriva el token de cada link de firma y los hashes de OTP (HMAC). Si se filtra, se pueden
  // recalcular todos los links: tratarlo como un secreto de primer nivel y no cambiarlo con
  // solicitudes PENDING vivas.
  TOKEN_SECRET: z.string().min(32, 'TOKEN_SECRET debe tener al menos 32 caracteres'),
  // Base pública de la página de firma; el link es `${PUBLIC_BASE_URL}/s/${token}`.
  PUBLIC_BASE_URL: z.url(),
  // Clave maestra para cifrar contraseñas SMTP, secretos de webhook y archivos. Opcional para
  // arrancar, pero sin ella no se pueden guardar esas cosas.
  SECRETS_KEY: z.string().optional(),
  // SOLO DESARROLLO: si el tenant no tiene correo configurado, el OTP no se envía y se devuelve en la
  // respuesta. Es un agujero total en producción, así que el arranque se niega a combinarlo con
  // NODE_ENV=production.
  ALLOW_DEV_OTP: boolean(false),
  // SOLO DESARROLLO Y PRUEBAS: permite que un webhook apunte a direcciones privadas o locales
  // (localhost, 10.x, 192.168.x…). En producción abriría la red interna a quien configure un webhook,
  // así que el arranque se niega a combinarlo con NODE_ENV=production.
  WEBHOOK_ALLOW_PRIVATE: boolean(false),
  // Saltos de proxy delante de la API (p. ej. 1 con el túnel de Cloudflare). Sin esto la IP que se
  // guarda como evidencia sería la del proxy, no la del firmante.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).optional(),
  // Carpeta de los archivos cifrados (fotos y PDF). Fuera del repo y con copias de respaldo.
  STORAGE_DIR: z.string().min(1).default('./storage'),
  // Tareas en segundo plano (entrega de webhooks, vencimiento, retención). Se apagan en pruebas, que
  // las invocan a mano para controlar el momento.
  BACKGROUND_JOBS: boolean(true),
  // Peticiones por minuto y por IP a los endpoints PÚBLICOS de firma (sin clave de API).
  PUBLIC_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(60),
  // Panel compilado (`apps/web/dist`). Si existe, la API lo sirve en la misma dirección y puerto:
  // un solo proceso y una sola ruta de túnel en producción.
  WEB_DIST_DIR: z.string().min(1).optional(),
  // Autoridad de sellado de tiempo (RFC 3161). Sin ella las firmas se sellan igual, pero sin hora de un tercero.
  TSA_URL: z.url().optional(),
});

export type AppConfig = {
  databaseUrl: string;
  port: number;
  host: string;
  isProduction: boolean;
  tokenSecret: string;
  publicBaseUrl: string;
  secretsKey: Buffer | null;
  allowDevOtp: boolean;
  webhookAllowPrivate: boolean;
  trustProxy: number | null;
  storageDir: string;
  backgroundJobs: boolean;
  publicRateLimitPerMin: number;
  webDistDir: string | null;
  tsaUrl: string | null;
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
  if (isProduction && e.WEBHOOK_ALLOW_PRIVATE) {
    throw new Error('WEBHOOK_ALLOW_PRIVATE=true no se puede usar con NODE_ENV=production.');
  }
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    host: e.HOST,
    isProduction,
    tokenSecret: e.TOKEN_SECRET,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    secretsKey: e.SECRETS_KEY ? parseSecretsKey(e.SECRETS_KEY) : null,
    allowDevOtp: e.ALLOW_DEV_OTP,
    webhookAllowPrivate: e.WEBHOOK_ALLOW_PRIVATE,
    trustProxy: e.TRUST_PROXY ?? null,
    storageDir: resolve(e.STORAGE_DIR),
    backgroundJobs: e.BACKGROUND_JOBS,
    publicRateLimitPerMin: e.PUBLIC_RATE_LIMIT_PER_MIN,
    webDistDir: e.WEB_DIST_DIR ? resolve(e.WEB_DIST_DIR) : null,
    tsaUrl: e.TSA_URL ?? null,
  };
}
