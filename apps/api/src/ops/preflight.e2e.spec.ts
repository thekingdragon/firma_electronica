/**
 * Verificación previa a producción: detecta lo que falta y da por bueno un entorno bien armado. Requiere TEST_DATABASE_URL.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { insertUser } from '../auth/users.service';
import { saveMailSettings } from '../mail/mail.service';
import { createTenant } from '../tenants/tenants.service';
import { publishTemplate } from '../tenants/templates.service';
import { resetDatabase, testDatabaseUrl } from '../test-utils';
import { Check, PreflightInput, runPreflight } from './preflight';

const URL_DB = testDatabaseUrl();
const KEY_B64 = randomBytes(32).toString('base64');

describe('verificación previa a producción', () => {
  let owner: Pool;
  let runtime: Pool;
  let base: string;
  let tenantId: string;

  const fallas = (cs: Check[]) => cs.filter((c) => c.level === 'falla').map((c) => c.title);
  const avisos = (cs: Check[]) => cs.filter((c) => c.level === 'aviso').map((c) => c.title);
  const tiene = (lista: string[], texto: RegExp) => lista.some((t) => texto.test(t));

  async function entorno(extra: NodeJS.ProcessEnv = {}): Promise<PreflightInput> {
    const storage = join(base, 'archivos');
    const dist = join(base, 'dist');
    await mkdir(storage, { recursive: true });
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'index.html'), '<html></html>');
    return {
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: URL_DB,
        TOKEN_SECRET: 't'.repeat(60),
        PUBLIC_BASE_URL: 'https://firma.corredora.pe',
        SECRETS_KEY: KEY_B64,
        STORAGE_DIR: storage,
        WEB_DIST_DIR: dist,
        TRUST_PROXY: '1',
        TSA_URL: 'http://timestamp.digicert.com',
        REQUIRE_LEGAL_REVIEW: 'true',
        ...extra,
      } as NodeJS.ProcessEnv,
      owner,
      runtime,
      migrationsDir: join(__dirname, '..', '..', 'migrations'),
      backupsDir: join(base, 'respaldos'),
      repoDir: join(base, 'repo'),
    };
  }

  beforeAll(async () => {
    owner = await resetDatabase(URL_DB);
    const u = new URL(URL_DB);
    u.username = 'firma_runtime';
    u.password = '';
    runtime = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL ?? u.toString() });
    base = await mkdtemp(join(tmpdir(), 'fes-preflight-'));
    tenantId = (await createTenant(owner, { name: 'Corredora', country: 'PE', legalName: 'Corredora SAC' })).tenant.id;
  }, 60_000);

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('un entorno de desarrollo recién armado FALLA y dice qué hacer en cada punto', async () => {
    const cs = await runPreflight(await entorno({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'https://abc-def.trycloudflare.com' }));
    const f = fallas(cs);
    expect(tiene(f, /NODE_ENV/)).toBe(true);
    expect(tiene(f, /dirección provisional/)).toBe(true);
    expect(tiene(f, /ningún operador/)).toBe(true);
    expect(tiene(f, /sin correo configurado/)).toBe(true);
    expect(cs.filter((c) => c.level !== 'ok').every((c) => Boolean(c.fix))).toBe(true);
  });

  it('con ALLOW_DEV_OTP encendido o sin APP_DATABASE_URL, falla', async () => {
    const dev = await runPreflight(await entorno({ ALLOW_DEV_OTP: 'true', NODE_ENV: 'development' }));
    expect(tiene(fallas(dev), /ALLOW_DEV_OTP/)).toBe(true);
    const sinRls = await runPreflight({ ...(await entorno()), runtime: null });
    expect(tiene(fallas(sinRls), /Sin APP_DATABASE_URL/)).toBe(true);
  });

  it('con el runtime conectado como el dueño, RLS no cuenta como activo', async () => {
    const cs = await runPreflight({ ...(await entorno()), runtime: owner });
    expect(tiene(fallas(cs), /RLS no activo/)).toBe(true);
  });

  it('un entorno completo pasa sin ninguna falla; lo único que queda son avisos', async () => {
    await insertUser(owner, { tenantId: null, email: 'ana@gcmtechnology.com', name: 'Ana', role: 'OPERATOR' });
    await owner.query("UPDATE users SET mfa_enabled_at = now() WHERE role = 'OPERATOR'");
    const admin = await insertUser(owner, { tenantId, email: 'gerente@corredora.pe', name: 'Gerente', role: 'ADMIN' });
    await owner.query('UPDATE users SET mfa_enabled_at = now() WHERE id = $1', [admin.id]);
    await saveMailSettings(owner, Buffer.from(KEY_B64, 'base64'), tenantId, { host: 'smtp.example.org', port: 587, fromEmail: 'avisos@corredora.pe' });
    await owner.query('UPDATE tenant_mail_settings SET verified_at = now()');
    await publishTemplate(owner, tenantId, 'APPOINTMENT_LETTER', { legalReviewed: true, publishedBy: 'Abogada' });
    const respaldo = join(base, 'respaldos', '20301231-000000');
    await mkdir(respaldo, { recursive: true });
    await writeFile(join(respaldo, 'MANIFIESTO.json'), '{}');
    const cs = await runPreflight(await entorno());
    expect(fallas(cs)).toEqual([]);
    expect(avisos(cs)).toEqual([]);
  });

  it('avisa de usuarios que parecen de prueba y de que el último respaldo es viejo', async () => {
    await insertUser(owner, { tenantId, email: 'admin@local.test', name: 'Prueba', role: 'REVIEWER' });
    const cs = await runPreflight({ ...(await entorno()), now: new Date(Date.now() + 5 * 86_400_000) });
    expect(tiene(avisos(cs), /parecen de prueba/)).toBe(true);
    expect(tiene(avisos(cs), /último respaldo tiene/)).toBe(true);
    expect(fallas(cs)).toEqual([]);
  });

  it('no filtra secretos: ni la clave ni la URL de la base aparecen en el informe', async () => {
    const cs = await runPreflight(await entorno());
    const texto = JSON.stringify(cs);
    expect(texto).not.toContain(KEY_B64);
    expect(texto).not.toContain('t'.repeat(60));
  });
});
