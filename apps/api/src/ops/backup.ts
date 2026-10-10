/**
 * Respaldo del servicio: la base de datos (pg_dump) y los archivos cifrados (fotos, PDF sellados, sellos de tiempo), con un
 * manifiesto que lleva la huella de cada archivo para poder comprobar después que el respaldo está completo y sin cambios.
 *
 *   npm run backup -w api -- [--out <carpeta>] [--keep <cuántos conservar>]
 *   npm run backup -w api -- --verify <carpeta-del-respaldo>
 *
 * NO incluye SECRETS_KEY: sin esa clave las fotos, los PDF y la llave de sello del respaldo no se pueden abrir. Guárdela
 * APARTE (y respáldela en otro lugar): quien tenga el respaldo y la clave tiene todo; quien tenga solo uno de los dos, nada.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface BackupOptions {
  databaseUrl: string;
  storageDir: string;
  outDir: string;
  /** Cuántos respaldos conservar (los más nuevos). 0 = no borrar ninguno. */
  keep?: number;
  /** Ruta de pg_dump; si no, la variable PG_DUMP, el PATH o la instalación habitual de Windows. */
  pgDump?: string;
  now?: Date;
}

export interface BackupManifest {
  createdAt: string;
  database: { file: string; sha256: string; bytes: number };
  storage: { files: number; bytes: number };
  /** Huella de cada archivo del respaldo, con ruta relativa a la carpeta del respaldo. */
  files: Record<string, string>;
  note: string;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

async function findPgDump(explicit?: string): Promise<string> {
  const candidates = [explicit, process.env.PG_DUMP].filter((x): x is string => Boolean(x));
  for (const c of candidates) if (existsSync(c)) return c;
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\PostgreSQL';
    if (existsSync(base)) {
      for (const v of (await readdir(base)).sort().reverse()) {
        const p = join(base, v, 'bin', 'pg_dump.exe');
        if (existsSync(p)) return p;
      }
    }
  }
  return 'pg_dump';
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

export async function runBackup(opts: BackupOptions): Promise<{ dir: string; manifest: BackupManifest }> {
  const now = opts.now ?? new Date();
  const dir = resolve(opts.outDir, stamp(now));
  await mkdir(dir, { recursive: true });

  // La base: la contraseña va por entorno, no por argumento (un argumento queda a la vista de todos los procesos).
  const u = new URL(opts.databaseUrl);
  const dumpFile = join(dir, 'base.dump');
  await run(
    await findPgDump(opts.pgDump),
    ['--format=custom', '--no-owner', `--host=${u.hostname}`, `--port=${u.port || '5432'}`, `--username=${decodeURIComponent(u.username)}`, `--dbname=${u.pathname.slice(1)}`, `--file=${dumpFile}`],
    { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, windowsHide: true },
  );

  // Los archivos cifrados, tal cual están en disco.
  const storageCopy = join(dir, 'storage');
  if (existsSync(opts.storageDir)) await cp(opts.storageDir, storageCopy, { recursive: true });
  else await mkdir(storageCopy, { recursive: true });

  const files: Record<string, string> = {};
  let bytes = 0;
  let count = 0;
  for (const f of await walk(storageCopy)) {
    const b = await readFile(f);
    files[relative(dir, f).split(sep).join('/')] = sha(b);
    bytes += b.length;
    count++;
  }
  const dump = await readFile(dumpFile);
  files['base.dump'] = sha(dump);

  const manifest: BackupManifest = {
    createdAt: now.toISOString(),
    database: { file: 'base.dump', sha256: sha(dump), bytes: dump.length },
    storage: { files: count, bytes },
    files,
    note: 'Este respaldo NO incluye SECRETS_KEY. Sin ella no se pueden abrir las fotos, los PDF ni la llave de sello. Guárdela aparte.',
  };
  await writeFile(join(dir, 'MANIFIESTO.json'), JSON.stringify(manifest, null, 2));

  if (opts.keep && opts.keep > 0) {
    const all = (await readdir(resolve(opts.outDir), { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name)).map((e) => e.name).sort();
    for (const old of all.slice(0, Math.max(0, all.length - opts.keep))) await rm(join(resolve(opts.outDir), old), { recursive: true, force: true });
  }
  return { dir, manifest };
}

export interface BackupCheck {
  ok: boolean;
  checked: number;
  problems: string[];
}

/** Comprueba que un respaldo está completo y sin cambios: cada archivo existe y su huella es la del manifiesto. */
export async function verifyBackup(dir: string): Promise<BackupCheck> {
  const problems: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'MANIFIESTO.json'), 'utf8')) as BackupManifest;
  } catch {
    return { ok: false, checked: 0, problems: ['No se encontró o no se pudo leer MANIFIESTO.json.'] };
  }
  let checked = 0;
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const p = join(dir, rel);
    try {
      if (sha(await readFile(p)) !== expected) problems.push(`${rel}: cambió (la huella no coincide).`);
    } catch {
      problems.push(`${rel}: falta.`);
    }
    checked++;
  }
  // Un archivo de más en el respaldo también es una diferencia.
  const storageDir = join(dir, 'storage');
  if (existsSync(storageDir)) {
    for (const f of await walk(storageDir)) {
      const rel = relative(dir, f).split(sep).join('/');
      if (!(rel in manifest.files)) problems.push(`${rel}: no figura en el manifiesto.`);
    }
  }
  if (!(await stat(join(dir, 'base.dump')).catch(() => null))) problems.push('base.dump: falta.');
  return { ok: problems.length === 0, checked, problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// Línea de comandos
// ---------------------------------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  // Se cargan aquí, no arriba: las pruebas importan este archivo sin tocar el entorno ni la base.
  const dotenv = await import('dotenv');
  dotenv.config();
  const { loadConfig } = await import('../config/config');
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  if (process.argv.includes('--verify')) {
    const dir = process.argv[process.argv.indexOf('--verify') + 1];
    if (!dir) throw new Error('Uso: --verify <carpeta-del-respaldo>');
    const r = await verifyBackup(resolve(dir));
    console.log(`${r.checked} archivos comprobados: ${r.ok ? 'el respaldo está completo y sin cambios.' : 'HAY PROBLEMAS:'}`);
    for (const p of r.problems) console.log(` - ${p}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  const config = loadConfig();
  const keep = arg('keep') === undefined ? 14 : Number(arg('keep'));
  if (!Number.isInteger(keep) || keep < 0) throw new Error('--keep debe ser un entero (0 = no borrar nada).');
  const { dir, manifest } = await runBackup({ databaseUrl: config.databaseUrl, storageDir: config.storageDir, outDir: arg('out') ?? './backups', keep });
  const check = await verifyBackup(dir);
  console.log(`Respaldo creado en ${dir}`);
  console.log(`  base: ${(manifest.database.bytes / 1024).toFixed(0)} KB · archivos cifrados: ${manifest.storage.files} (${(manifest.storage.bytes / 1024).toFixed(0)} KB)`);
  console.log(`  comprobación: ${check.ok ? 'completo y sin cambios' : 'CON PROBLEMAS: ' + check.problems.join('; ')}`);
  console.log('  Recuerde: el respaldo NO incluye SECRETS_KEY. Guárdela aparte.');
  process.exitCode = check.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  });
}
