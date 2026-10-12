import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Pool } from 'pg';
import { defer, lastValueFrom, Observable } from 'rxjs';
import { sha256Hex } from '../common/crypto';
import { metaStorage, tenantStorage } from './tenant-context';

const OWNER = 'PG_OWNER';
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/**
 * Fija la corredora del flujo antes de ejecutar el handler (los guards ya corrieron):
 *  - rutas de la corredora: la que dejó el guard (`req.tenant`, de la clave de API o de la sesión);
 *  - páginas públicas de firma (`/v1/sign/:token`): la dueña del enlace, que se busca por el hash del token con el pool
 *    del dueño (aún no se sabe cuál es). Un token que no existe corre SIN corredora y RLS no deja ver nada.
 *  - todo lo demás (login, operador, salud): sin corredora.
 *
 * El handler se ejecuta dentro de `tenantStorage.run`, y por eso se suscribe dentro de la promesa: si se devolviera el
 * observable sin más, Nest lo suscribiría fuera del contexto y las consultas no verían la corredora.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(@Inject(OWNER) private readonly owner: Pool) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request & { tenant?: { id: string } }>();
    const meta = { ip: req.ip ?? null, userAgent: req.get?.('user-agent') ?? null };
    return defer(() =>
      metaStorage.run(meta, async () => {
        const tenantId = req.tenant?.id ?? (await this.tenantOfLink(req.params?.token));
        if (!tenantId) return lastValueFrom(next.handle(), { defaultValue: undefined });
        return tenantStorage.run({ tenantId }, () => lastValueFrom(next.handle(), { defaultValue: undefined }));
      }),
    );
  }

  private async tenantOfLink(token: unknown): Promise<string | null> {
    if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) return null;
    const { rows } = await this.owner.query<{ tenant_id: string }>('SELECT tenant_id FROM signature_requests WHERE token_hash = $1', [sha256Hex(token)]);
    return rows[0]?.tenant_id ?? null;
  }
}
