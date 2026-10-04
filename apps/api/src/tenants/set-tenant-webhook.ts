/**
 * Configura el webhook de un tenant: la URL a la que el servicio avisa (firmado, vencido, revocado,
 * revisado) y, con --rotate, un secreto nuevo para verificar la firma. El secreto se imprime UNA vez;
 * en la base queda cifrado. Rotar invalida el anterior de inmediato.
 *
 *   npm run tenant:webhook -w api -- --tenant <uuid> --url https://host.ejemplo.com/hooks/firma --rotate
 *   npm run tenant:webhook -w api -- --tenant <uuid> --url ""        # quita la URL (deja de avisar)
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { loadConfig } from '../config/config';
import { assertPublicUrl } from '../webhooks/ssrf';
import { setTenantWebhook } from './tenants.service';
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const tenantId = arg('tenant');
  if (!tenantId) throw new Error('Uso: --tenant <uuid> [--url <https://...> | --url ""] [--rotate]');
  if (!config.secretsKey) throw new Error('Falta SECRETS_KEY: no se puede cifrar el secreto del webhook.');

  const rawUrl = arg('url');
  const rotate = process.argv.includes('--rotate');
  if (rawUrl === undefined && !rotate) throw new Error('Indique --url y/o --rotate.');

  let url: string | null | undefined;
  if (rawUrl !== undefined) {
    if (rawUrl === '') url = null;
    else {
      // Misma regla que al entregar: en producción, https y nada de direcciones privadas.
      assertPublicUrl(rawUrl, config.webhookAllowPrivate);
      if (config.isProduction && !rawUrl.startsWith('https://')) throw new Error('En producción el webhook debe usar https.');
      url = rawUrl;
    }
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const { secret } = await setTenantWebhook(pool, config.secretsKey, tenantId, { url, rotateSecret: rotate });
    console.log(url === undefined ? 'URL sin cambios.' : url === null ? 'Webhook desactivado (sin URL).' : `URL del webhook: ${url}`);
    if (secret) {
      console.log('Guarda este secreto ahora; no se vuelve a mostrar (el anterior ya no sirve):');
      console.log(`  Secreto webhook: ${secret}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
