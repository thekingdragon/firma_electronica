/**
 * Recorre las solicitudes firmadas y comprueba su integridad de punta a punta (PDF, sello, sello de tiempo y bitácora).
 * Sale con código 1 si ALGUNA falla: sirve para programarlo (cada noche, tras un respaldo, tras restaurar uno).
 *
 *   npm run evidence:verify -w api -- [--tenant <uuid>] [--since <AAAA-MM-DD>]
 *
 * Las firmas anteriores al sello de integridad se informan aparte («sin sello»): no son una alteración, pero tampoco
 * tienen la protección del sello. Se cuentan como problema solo si se pasa --strict.
 */
import { Pool } from 'pg';
import { StorageService } from '../storage/storage.service';
import { NO_SEAL_REASON } from '../seal/seal';
import { IntegrityReport, checkIntegrity } from '../seal/integrity';

export interface VerifySummary {
  total: number;
  ok: number;
  unsealed: number;
  failed: IntegrityReport[];
}

export async function verifyAll(
  pool: Pool,
  storage: StorageService,
  opts: { tenantId?: string; since?: string; strict?: boolean } = {},
): Promise<VerifySummary> {
  const params: unknown[] = [];
  const where = ["status = 'SIGNED'"];
  if (opts.tenantId) {
    params.push(opts.tenantId);
    where.push(`tenant_id = $${params.length}`);
  }
  if (opts.since) {
    params.push(opts.since);
    where.push(`signed_at >= $${params.length}::date`);
  }
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM signature_requests WHERE ${where.join(' AND ')} ORDER BY signed_at`, params);
  const out: VerifySummary = { total: rows.length, ok: 0, unsealed: 0, failed: [] };
  for (const { id } of rows) {
    const r = await checkIntegrity(pool, storage, id);
    const onlyUnsealed = !r.ok && !r.seal.present && r.pdfIntact && r.chain.ok;
    if (r.ok) out.ok++;
    else if (onlyUnsealed && !opts.strict) out.unsealed++;
    else out.failed.push(r);
  }
  return out;
}

async function main(): Promise<void> {
  const dotenv = await import('dotenv');
  dotenv.config();
  const { loadConfig } = await import('../config/config');
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const s = await verifyAll(pool, new StorageService(config), { tenantId: arg('tenant'), since: arg('since'), strict: process.argv.includes('--strict') });
    console.log(`${s.total} firmas revisadas: ${s.ok} íntegras, ${s.unsealed} anteriores al sello (${NO_SEAL_REASON.toLowerCase()}), ${s.failed.length} con problemas.`);
    for (const f of s.failed) {
      console.log(`\n✗ ${f.reference} (${f.requestId})`);
      for (const p of f.problems) console.log(`   - ${p}`);
    }
    process.exitCode = s.failed.length === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  });
}
