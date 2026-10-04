import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const NOMBRE_VALIDO = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Aplica las migraciones pendientes de `dir` en orden, una transacción por archivo, y deja
 * constancia en `schema_migrations`. Devuelve los nombres aplicados en esta corrida.
 */
export async function applyMigrations(connectionString: string, dir: string): Promise<string[]> {
  const archivos = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const invalidos = archivos.filter((f) => !NOMBRE_VALIDO.test(f));
  if (invalidos.length) {
    throw new Error(`Nombres de migración inválidos (usar NNNN_nombre.sql): ${invalidos.join(', ')}`);
  }

  const client = new Client({ connectionString });
  await client.connect();
  const aplicadas: string[] = [];
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
      aplicadas.push(archivo);
    }
  } finally {
    await client.end();
  }
  return aplicadas;
}
