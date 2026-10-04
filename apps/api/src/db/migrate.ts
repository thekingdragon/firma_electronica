/**
 * Aplica las migraciones de `migrations/*.sql` (ver migrations.ts). Se escriben a mano; no hay
 * generador.
 *
 *   npm run db:migrate
 */
import { join } from 'node:path';
import * as dotenv from 'dotenv';
import { applyMigrations } from './migrations';
dotenv.config();

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL en el entorno.');
  const aplicadas = await applyMigrations(url, join(process.cwd(), 'migrations'));
  for (const a of aplicadas) console.log(`Aplicada ${a}`);
  console.log(aplicadas.length ? `${aplicadas.length} migración(es) aplicada(s).` : 'Base al día.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
