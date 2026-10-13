/**
 * Verificación previa a producción: revisa de una vez la configuración, la base y los datos, y dice qué falta antes de poner el
 * servicio frente a clientes reales. Sale con código 1 si hay algún «FALLA» (los «AVISO» no la detienen).
 *
 *   npm run preflight -w api
 *
 * No cambia nada y no imprime secretos. Lo que NO puede comprobar desde aquí (que los respaldos estén FUERA de esta máquina, que
 * SECRETS_KEY esté guardada aparte, que el abogado haya aprobado el texto) lo dice al final, para que no se dé por hecho.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Pool } from 'pg';
import { AppConfig, loadConfig } from '../config/config';
import { DbIsolationService } from '../db/db.module';

export type Level = 'ok' | 'aviso' | 'falla';
export interface Check {
  level: Level;
  title: string;
  /** Qué hacer, cuando no está ok. */
  fix?: string;
}

export interface PreflightInput {
  env: NodeJS.ProcessEnv;
  /** Conexión del dueño (DATABASE_URL). */
  owner: Pool;
  /** Conexión del runtime (APP_DATABASE_URL), si está definida. */
  runtime: Pool | null;
  migrationsDir: string;
  backupsDir: string;
  /** Carpeta del repositorio, para avisar si los archivos cifrados viven dentro de él. */
  repoDir: string;
  now?: Date;
}

const ok = (title: string): Check => ({ level: 'ok', title });
const aviso = (title: string, fix: string): Check => ({ level: 'aviso', title, fix });
const falla = (title: string, fix: string): Check => ({ level: 'falla', title, fix });

export async function runPreflight(input: PreflightInput): Promise<Check[]> {
  const out: Check[] = [];
  const { env } = input;

  // ---------------------------------------------------------------- configuración
  let config: AppConfig | null = null;
  try {
    config = loadConfig(env);
    out.push(ok('La configuración es válida'));
  } catch (e) {
    out.push(falla(`La configuración no es válida: ${(e as Error).message}`, 'Corrija apps/api/.env (compare con .env.example).'));
  }

  if (env.NODE_ENV === 'production') out.push(ok('NODE_ENV=production'));
  else out.push(falla(`NODE_ENV es «${env.NODE_ENV ?? 'sin definir'}», no production`, 'Defina NODE_ENV=production (activa las cookies seguras y las restricciones de producción).'));

  if (config) {
    out.push(config.allowDevOtp ? falla('ALLOW_DEV_OTP=true: el código de verificación se mostraría en pantalla', 'Ponga ALLOW_DEV_OTP=false.') : ok('ALLOW_DEV_OTP apagado (el código solo llega por correo)'));
    out.push(config.webhookAllowPrivate ? falla('WEBHOOK_ALLOW_PRIVATE=true abre la red interna a los webhooks', 'Ponga WEBHOOK_ALLOW_PRIVATE=false.') : ok('Los webhooks no pueden apuntar a la red interna'));

    const url = new URL(config.publicBaseUrl);
    if (url.protocol !== 'https:') out.push(falla(`PUBLIC_BASE_URL no es https (${config.publicBaseUrl})`, 'Los enlaces de firma y la cámara exigen https. Use la dirección pública con https.'));
    else if (/^(localhost|127\.|10\.|192\.168\.)/.test(url.hostname) || url.hostname.endsWith('.trycloudflare.com')) {
      out.push(falla(`PUBLIC_BASE_URL apunta a una dirección provisional (${url.hostname})`, 'Use la dirección pública definitiva: un enlace de prueba cambia y deja de abrir los enlaces ya enviados.'));
    } else out.push(ok(`PUBLIC_BASE_URL definitiva (${url.hostname})`));

    out.push(config.trustProxy === null || config.trustProxy === 0 ? aviso('TRUST_PROXY sin definir o en 0', 'Detrás del túnel de Cloudflare ponga TRUST_PROXY=1; si no, todos los firmantes comparten una IP y un cupo.') : ok(`TRUST_PROXY=${config.trustProxy}`));
    out.push(config.secretsKey ? ok('SECRETS_KEY definida') : falla('Falta SECRETS_KEY', 'Sin ella no se pueden guardar fotos, PDF ni contraseñas de correo.'));
    out.push(config.tokenSecret.length >= 48 ? ok('TOKEN_SECRET con largo suficiente') : aviso(`TOKEN_SECRET tiene ${config.tokenSecret.length} caracteres`, 'Use 48 o más (comando en .env.example).'));
    out.push(config.tsaUrl ? ok('Sello de tiempo de un tercero configurado (TSA_URL)') : aviso('Sin TSA_URL: la fecha de cada firma es solo la del servidor', 'Defina TSA_URL (p. ej. http://timestamp.digicert.com, gratuita).'));
    out.push(config.operatorAllowRemote ? aviso('OPERATOR_ALLOW_REMOTE=true: el panel de operador se abre por Internet', 'Déjelo en false salvo que sea imprescindible.') : ok('El panel de operador no se abre por el túnel'));
    out.push(config.requireLegalReview ? ok('Revisión legal obligatoria activa (REQUIRE_LEGAL_REVIEW)') : aviso('REQUIRE_LEGAL_REVIEW apagada: se puede firmar con textos en borrador', 'Enciéndala cuando el texto definitivo esté publicado.'));

    // Archivos
    try {
      await access(config.storageDir, constants.W_OK);
      out.push(ok('La carpeta de archivos existe y se puede escribir'));
    } catch {
      out.push(falla(`La carpeta de archivos (${config.storageDir}) no existe o no se puede escribir`, 'Cree la carpeta o corrija STORAGE_DIR.'));
    }
    const repo = resolve(input.repoDir) + sep;
    if ((resolve(config.storageDir) + sep).startsWith(repo)) {
      out.push(aviso('La carpeta de archivos cifrados está DENTRO del repositorio', 'Muévala fuera del repositorio y con respaldo: un `git clean` o una copia del código no debe tocar las firmas.'));
    }
    if (config.webDistDir) out.push(existsSync(join(config.webDistDir, 'index.html')) ? ok('El panel compilado existe (WEB_DIST_DIR)') : falla(`No hay panel compilado en ${config.webDistDir}`, 'Ejecute `npm run build` en la raíz y reinicie.'));
    else out.push(aviso('WEB_DIST_DIR sin definir: la API no sirve el panel', 'Defina WEB_DIST_DIR=../web/dist tras compilar el panel.'));
  }

  // ---------------------------------------------------------------- base de datos
  try {
    await input.owner.query('SELECT 1');
  } catch (e) {
    out.push(falla(`No se puede conectar a la base: ${(e as Error).message}`, 'Revise DATABASE_URL y que PostgreSQL esté en marcha.'));
    return out;
  }

  const aplicadas = new Set((await input.owner.query<{ name: string }>('SELECT name FROM schema_migrations').catch(() => ({ rows: [] as { name: string }[] }))).rows.map((r) => r.name));
  const archivos = existsSync(input.migrationsDir) ? readdirSync(input.migrationsDir).filter((f) => f.endsWith('.sql')) : [];
  const faltan = archivos.filter((f) => !aplicadas.has(f));
  out.push(faltan.length ? falla(`Faltan ${faltan.length} migración(es): ${faltan.join(', ')}`, 'Ejecute `npm run db:migrate -w api` antes de reiniciar.') : ok(`Migraciones al día (${archivos.length})`));

  if (!input.runtime) {
    out.push(falla('Sin APP_DATABASE_URL: la API corre con el dueño y el aislamiento entre corredoras (RLS) NO se aplica', 'Cree el rol firma_runtime, ejecute `npm run db:grant -w api` y defina APP_DATABASE_URL (docs/DESPLIEGUE.md §1).'));
  } else {
    const iso = await new DbIsolationService().check(input.runtime);
    out.push(iso.rlsEnforced ? ok('Aislamiento entre corredoras (RLS) activo') : falla(`RLS no activo: ${iso.reason}`, 'Corrija APP_DATABASE_URL o ejecute `npm run db:grant -w api`.'));
  }

  // ---------------------------------------------------------------- personas
  const ops = (await input.owner.query<{ email: string; mfa: boolean }>("SELECT email, mfa_enabled_at IS NOT NULL AS mfa FROM users WHERE role = 'OPERATOR' AND active")).rows;
  if (ops.length === 0) out.push(falla('No hay ningún operador de la plataforma', 'Cree uno: `npm run operator:create -w api -- --email … --name …`.'));
  else if (!ops.some((o) => o.mfa)) out.push(aviso('Ningún operador activó todavía su segundo factor', 'Es obligatorio: lo pide al entrar la primera vez.'));
  else out.push(ok(`Operador(es) con segundo factor: ${ops.filter((o) => o.mfa).length}`));

  const prueba = (await input.owner.query<{ email: string }>("SELECT email FROM users WHERE active AND (email ~* '@(local|ejemplo|example|prueba)\\.' OR email ~* '(^|[._-])(prueba|test)([._-]|@)')")).rows;
  out.push(prueba.length ? aviso(`Hay usuarios que parecen de prueba: ${prueba.map((p) => p.email).join(', ')}`, 'Désactívelos o bórrelos antes de producción.') : ok('No se ven usuarios de prueba'));

  // ---------------------------------------------------------------- cada corredora
  const tenants = (
    await input.owner.query<{ id: string; name: string; mail: boolean; verified: boolean; admins: string; admin_mfa: string; unreviewed: string }>(
      `SELECT t.id, t.name, (m.tenant_id IS NOT NULL) AS mail, (m.verified_at IS NOT NULL) AS verified,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.role = 'ADMIN' AND u.active) AS admins,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.role = 'ADMIN' AND u.active AND u.mfa_enabled_at IS NOT NULL) AS admin_mfa,
              (SELECT count(*) FROM document_templates d WHERE d.tenant_id = t.id AND d.active AND COALESCE((d.body_json->>'legalReviewed')::boolean, false) = false) AS unreviewed
         FROM tenants t LEFT JOIN tenant_mail_settings m ON m.tenant_id = t.id WHERE t.active ORDER BY t.created_at`,
    )
  ).rows;
  if (tenants.length === 0) out.push(aviso('No hay ninguna corredora activa', 'Créela desde el panel de operador.'));
  for (const t of tenants) {
    out.push(!t.mail ? falla(`«${t.name}»: sin correo configurado (el firmante no recibiría el código)`, 'El administrador lo configura en Ajustes → Correo de la corredora.') : !t.verified ? aviso(`«${t.name}»: correo guardado pero sin probar`, 'Ajustes → Correo → «Enviar correo de prueba».') : ok(`«${t.name}»: correo verificado`));
    out.push(Number(t.admins) === 0 ? falla(`«${t.name}»: sin ningún administrador activo`, 'Agregue uno desde el panel de operador.') : Number(t.admin_mfa) === 0 ? aviso(`«${t.name}»: ningún administrador usa segundo factor`, 'Recomendado: ven toda la evidencia de la corredora.') : ok(`«${t.name}»: administrador con segundo factor`));
    out.push(Number(t.unreviewed) > 0 ? aviso(`«${t.name}»: ${t.unreviewed} plantilla(s) activa(s) sin revisión legal`, 'Publique el texto definitivo marcándolo como revisado por el abogado.') : ok(`«${t.name}»: plantillas con revisión legal`));
  }

  // ---------------------------------------------------------------- respaldos
  const now = (input.now ?? new Date()).getTime();
  let ultimo = 0;
  if (existsSync(input.backupsDir)) {
    for (const d of readdirSync(input.backupsDir)) {
      const p = join(input.backupsDir, d);
      if (statSync(p).isDirectory() && existsSync(join(p, 'MANIFIESTO.json'))) ultimo = Math.max(ultimo, statSync(join(p, 'MANIFIESTO.json')).mtimeMs);
    }
  }
  if (!ultimo) out.push(aviso('No hay ningún respaldo hecho', 'Ejecute `npm run backup -w api` y programe uno diario.'));
  else if (now - ultimo > 2 * 24 * 3600 * 1000) out.push(aviso(`El último respaldo tiene ${Math.floor((now - ultimo) / 86_400_000)} días`, 'Programe el respaldo diario.'));
  else out.push(ok('Hay un respaldo reciente (de menos de 2 días)'));

  return out;
}

/** Lo que ninguna comprobación automática puede asegurar. */
export const MANUAL_REMINDERS = [
  'Los respaldos están FUERA de esta máquina (otro disco o la nube): uno en el mismo disco no protege de una falla del disco.',
  'SECRETS_KEY está guardada APARTE del respaldo: sin ella, las fotos, los PDF y la llave de sello del respaldo no se pueden abrir.',
  'El abogado aprobó el texto legal y confirmó que la SBS y la aseguradora aceptan esta firma para el documento.',
  'La cámara se probó en celulares reales (al menos un iPhone y un Android de gama baja): ver docs/PRUEBA-CAMARA.md.',
  'El registro del banco de datos personales y el aviso de privacidad están resueltos (Ley 29733).',
];

const ICON: Record<Level, string> = { ok: '  ok   ', aviso: ' AVISO ', falla: ' FALLA ' };

async function main(): Promise<void> {
  const dotenv = await import('dotenv');
  dotenv.config();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL en el entorno.');
  const owner = new Pool({ connectionString: url });
  const runtime = process.env.APP_DATABASE_URL ? new Pool({ connectionString: process.env.APP_DATABASE_URL }) : null;
  try {
    const checks = await runPreflight({ env: process.env, owner, runtime, migrationsDir: join(process.cwd(), 'migrations'), backupsDir: resolve(process.env.BACKUPS_DIR ?? './backups'), repoDir: resolve(process.cwd(), '..', '..') });
    for (const c of checks) {
      console.log(`[${ICON[c.level]}] ${c.title}`);
      if (c.fix) console.log(`           → ${c.fix}`);
    }
    const f = checks.filter((c) => c.level === 'falla').length;
    const a = checks.filter((c) => c.level === 'aviso').length;
    console.log(`\n${checks.length - f - a} bien · ${a} aviso(s) · ${f} falla(s)`);
    console.log('\nLo que esta verificación NO puede comprobar y usted debe confirmar:');
    for (const r of MANUAL_REMINDERS) console.log(`  - ${r}`);
    process.exitCode = f > 0 ? 1 : 0;
  } finally {
    await owner.end();
    await runtime?.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  });
}
