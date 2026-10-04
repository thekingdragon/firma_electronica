import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../common/api-error';
import { Tenant, TenantsService } from './tenants.service';

export type TenantRequest = Request & { tenant?: Tenant };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly tenants: TenantsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    const key = req.header('x-api-key');
    const tenant = key ? await this.tenants.findByApiKey(key) : null;
    if (!tenant) {
      // Nunca se registra la clave recibida, solo de dónde vino el intento.
      this.logger.warn(`Clave de API ausente o inválida desde ${req.ip}`);
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
