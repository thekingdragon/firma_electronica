/**
 * Alta de un tenant desde la línea de comandos. Imprime la clave de API UNA vez: no se puede
 * recuperar después (en la base solo está su hash).
 *
 *   npm run tenant:create -w api -- --name "Mi Corredora" --country PE \
 *       --legal-name "Mi Corredora de Seguros S.A.C." [--registry "J-0000"] [--webhook-url https://...]
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { parseSecretsKey } from '../common/secret-box';
import { createTenant } from './tenants.service';
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL en el entorno.');
  const name = arg('name');
  const country = arg('country');
  const legalName = arg('legal-name');
  if (!name || !country || !legalName) {
    throw new Error('Uso: --name <nombre> --country <PE> --legal-name <razón social> [--registry <código>] [--webhook-url <https://...>]');
  }
  if (!/^[A-Za-z]{2}$/.test(country)) throw new Error('--country debe ser un código de 2 letras (ej. PE).');

  const pool = new Pool({ connectionString: url });
  try {
    const secretsKey = process.env.SECRETS_KEY ? parseSecretsKey(process.env.SECRETS_KEY) : null;
    const { tenant, apiKey, webhookSecret } = await createTenant(
      pool,
      { name, country, legalName, registryCode: arg('registry'), webhookUrl: arg('webhook-url') },
      secretsKey,
    );
    console.log(`Tenant creado: ${tenant.name} (${tenant.id})`);
    console.log('Guarda estos valores ahora; no se vuelven a mostrar:');
    console.log(`  X-Api-Key:       ${apiKey}`);
    if (webhookSecret) console.log(`  Secreto webhook: ${webhookSecret}`);
    else console.log('  Secreto webhook: (no se generó: falta SECRETS_KEY; use tenant:webhook cuando la configure)');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
