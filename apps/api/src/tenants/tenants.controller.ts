import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, CurrentTenant } from './api-key.guard';
import type { Tenant } from './tenants.service';

@Controller('v1/me')
@UseGuards(ApiKeyGuard)
export class TenantsController {
  /** Quién es el dueño de la clave. El panel lo usa para validar la clave al conectarse. */
  @Get()
  me(@CurrentTenant() tenant: Tenant): { name: string; country: string; legalName: string } {
    return { name: tenant.name, country: tenant.country, legalName: tenant.legalName };
  }
}
