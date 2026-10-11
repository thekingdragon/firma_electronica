import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Pool } from 'pg';
import { enforce } from '../auth/access.guard';
import { SessionUser, bearerToken, invalidSession, userFromAccessToken } from '../auth/session';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { ApiError } from '../common/api-error';
import { RateLimitService } from '../common/rate-limit';
import { Tenant, TenantsService } from './tenants.service';

export type TenantRequest = Request & { tenant?: Tenant; user?: SessionUser };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly tenants: TenantsService,
    private readonly limits: RateLimitService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    // El panel entra con sesión de usuario (Bearer); las integraciones máquina a máquina, con la clave de API.
    const bearer = bearerToken(req.header('authorization'));
    if (bearer) {
      const user = await userFromAccessToken(this.pool, this.config.tokenSecret, bearer);
      if (!user) throw invalidSession();
      if (!user.tenantId) throw new ApiError(403, 'FORBIDDEN_ROLE', 'El operador de la plataforma no opera dentro de una corredora.');
      enforce(this.reflector, context, user);
      const tenant = await this.tenants.findById(user.tenantId);
      if (!tenant) throw invalidSession();
      req.tenant = tenant;
      req.user = user;
      return true;
    }
    const key = req.header('x-api-key');
    const tenant = key ? await this.tenants.findByApiKey(key) : null;
    if (!tenant) {
      // Nunca se registra la clave recibida, solo de dónde vino el intento.
      this.logger.warn(`Clave de API ausente o inválida desde ${req.ip}`);
      // Pasados demasiados intentos fallidos de esa IP, se responde 429 en vez de 401. Una clave válida
      // nunca llega hasta acá, así que un host legítimo no se bloquea por culpa de otro.
      const wait = this.limits.recordApiKeyFailure(req.ip ?? 'desconocida');
      if (wait > 0) {
        context.switchToHttp().getResponse().setHeader('Retry-After', String(wait));
        throw new ApiError(429, 'RATE_LIMITED', 'Demasiados intentos con una clave inválida. Espere un momento.', { retryAfterSeconds: wait });
      }
      throw new ApiError(401, 'INVALID_API_KEY', 'Clave de API ausente o inválida.');
    }
    req.tenant = tenant;
    return true;
  }
}

/** El tenant autenticado por el guard. Solo usarlo en rutas protegidas con ApiKeyGuard. */
export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): Tenant => {
  const tenant = ctx.switchToHttp().getRequest<TenantRequest>().tenant;
  if (!tenant) throw new Error('CurrentTenant usado en una ruta sin ApiKeyGuard.');
  return tenant;
});
