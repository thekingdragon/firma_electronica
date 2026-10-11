import { Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Pool, PoolClient } from 'pg';
import * as dotenv from 'dotenv';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { currentTenantId } from './tenant-context';
dotenv.config();

/**
 * Pool de RUNTIME: lo que usan los servicios de una corredora. Se conecta con el rol sin privilegios (APP_DATABASE_URL),
 * sujeto a Row-Level Security, y fija `app.current_tenant` en CADA conexión que entrega, a partir del contexto de la
 * petición (ver tenant-context.ts). Sin contexto, RLS no deja ver nada.
 */
export const PG_POOL = 'PG_POOL';

/**
 * Pool del DUEÑO de la base (DATABASE_URL): no está sujeto a RLS. Solo para lo que por naturaleza cruza corredoras o
 * ocurre antes de saber cuál es: login y usuarios, alta de corredoras, panel de operador, tareas en segundo plano,
 * y la búsqueda de la corredora a partir de la clave de API o del token del enlace. Cada consulta que lo use debe filtrar
 * por un identificador explícito (no hay red de seguridad de RLS aquí).
 */
export const PG_OWNER = 'PG_OWNER';

/** Estado del aislamiento, para mostrarlo en el panel de operador y avisar al arrancar. */
export const DB_ISOLATION = 'DB_ISOLATION';

export interface DbIsolation {
  /** El runtime usa un rol sujeto a RLS (y no el dueño o un superusuario). */
  rlsEnforced: boolean;
  /** Por qué no, cuando no lo está. */
  reason: string | null;
}

/**
 * Fachada con la forma de `Pool` que usan los servicios. Cada `query` y cada `connect` sacan una conexión del pool
 * crudo y le fijan el tenant del contexto ANTES de usarla, así que una conexión nunca arrastra el tenant de otra petición.
 * No envuelve la petición en una transacción: las que ya abren los servicios siguen siendo suyas (un intento fallido de
 * OTP, por ejemplo, queda registrado aunque la petición termine en error).
 */
export class TenantPool {
  constructor(private readonly raw: Pool) {}

  private async scoped(): Promise<PoolClient> {
    const client = await this.raw.connect();
    try {
      await client.query("SELECT set_config('app.current_tenant', $1, false)", [currentTenantId() ?? '']);
    } catch (e) {
      client.release(true);
      throw e;
    }
    return client;
  }

  async query(...args: unknown[]): Promise<unknown> {
    const client = await this.scoped();
    try {
      return await (client.query as (...a: unknown[]) => Promise<unknown>).apply(client, args);
    } finally {
      client.release();
    }
  }

  connect(): Promise<PoolClient> {
    return this.scoped();
  }

  end(): Promise<void> {
    return this.raw.end();
  }
}

@Injectable()
export class DbIsolationService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Aislamiento');
  state: DbIsolation = { rlsEnforced: false, reason: 'sin comprobar' };
  private runtime: Pool | null = null;

  /** Consulta con la identidad del RUNTIME si el rol con que corre está sujeto a RLS. */
  async check(runtime: Pool): Promise<DbIsolation> {
    try {
      const { rows } = await runtime.query<{ bypass: boolean; rls: boolean }>(
        `SELECT (r.rolsuper OR r.rolbypassrls OR c.relowner = r.oid) AS bypass, c.relrowsecurity AS rls
           FROM pg_roles r, pg_class c WHERE r.rolname = current_user AND c.relname = 'signature_requests'`,
      );
      const r = rows[0];
      if (!r) return { rlsEnforced: false, reason: 'no se pudo comprobar el rol de runtime' };
      if (!r.rls) return { rlsEnforced: false, reason: 'las tablas no tienen RLS activado (falta aplicar la migración 0012)' };
      if (r.bypass) return { rlsEnforced: false, reason: 'el runtime corre con el dueño de la base (falta APP_DATABASE_URL con el rol firma_runtime)' };
      return { rlsEnforced: true, reason: null };
    } catch (e) {
      return { rlsEnforced: false, reason: (e as Error).message };
    }
  }

  async setRuntime(runtime: Pool): Promise<void> {
    this.runtime = runtime;
    this.state = await this.check(runtime);
  }

  /** Vuelve a comprobarlo (p. ej. tras aplicar una migración o cambiar el rol sin reiniciar la API). */
  async refresh(): Promise<DbIsolation> {
    if (this.runtime) this.state = await this.check(this.runtime);
    return this.state;
  }

  onApplicationBootstrap(): void {
    if (!this.state.rlsEnforced) {
      this.logger.warn(`El aislamiento entre corredoras (RLS) NO está activo: ${this.state.reason}. Hoy depende solo de que cada consulta filtre por tenant_id.`);
    } else {
      this.logger.log('Aislamiento entre corredoras (RLS) activo.');
    }
  }
}

function runtimeUrl(): string {
  const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL en el entorno.');
  return url;
}

@Global()
@Module({
  providers: [
    {
      provide: PG_OWNER,
      useFactory: (): Pool => {
        if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL en el entorno.');
        return new Pool({ connectionString: process.env.DATABASE_URL });
      },
    },
    { provide: 'PG_RUNTIME_RAW', useFactory: (): Pool => new Pool({ connectionString: runtimeUrl() }) },
    {
      provide: PG_POOL,
      inject: ['PG_RUNTIME_RAW'],
      // Los servicios la tipan como `Pool`: la fachada ofrece los mismos métodos que usan (query, connect, end).
      useFactory: (raw: Pool): Pool => new TenantPool(raw) as unknown as Pool,
    },
    DbIsolationService,
    {
      provide: DB_ISOLATION,
      inject: [DbIsolationService, 'PG_RUNTIME_RAW'],
      useFactory: async (svc: DbIsolationService, raw: Pool): Promise<DbIsolationService> => {
        await svc.setRuntime(raw);
        return svc;
      },
    },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [PG_POOL, PG_OWNER, DB_ISOLATION],
})
export class DbModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PG_OWNER) private readonly owner: Pool,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // La fachada cierra el pool crudo del runtime; el del dueño es otro pool.
    await this.pool.end();
    await this.owner.end();
  }
}
