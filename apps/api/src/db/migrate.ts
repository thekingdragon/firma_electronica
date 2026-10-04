/**
 * Aplica las migraciones de `migrations/*.sql` en orden, una transacción por archivo, y deja
 * constancia en `schema_migrations`. Las migraciones se escriben a mano; no hay generador.
 *
 *   npm run db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const NOMBRE_VALIDO = /^\d{4}_[a-z0-9_]+\.sql$/;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL en el entorno.');

  const dir = join(process.cwd(), 'migrations');
  const archivos = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const invalidos = archivos.filter((f) => !NOMBRE_VALIDO.test(f));
  if (invalidos.length) {
    throw new Error(`Nombres de migración inválidos (usar NNNN_nombre.sql): ${invalidos.join(', ')}`);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name        text PRIMARY KEY,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const hechas = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );

    let aplicadas = 0;
    for (const archivo of archivos) {
      if (hechas.has(archivo)) continue;
      const sql = readFileSync(join(dir, archivo), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [archivo]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${archivo}: ${(e as Error).message}`);
      }
      console.log(`Aplicada ${archivo}`);
      aplicadas++;
    }
    console.log(aplicadas ? `${aplicadas} migración(es) aplicada(s).` : 'Base al día.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
