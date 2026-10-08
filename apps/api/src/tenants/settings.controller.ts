import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { Pool } from 'pg';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { PG_POOL } from '../db/db.module';
import { ApiKeyGuard, CurrentTenant } from './api-key.guard';
import type { Tenant } from './tenants.service';

export interface TenantSettings {
  /** Aviso sobre el uso de datos personales que va al pie de los correos del servicio. `null` si no hay. */
  privacyNotice: string | null;
}

const bodySchema = z
  .object({
    privacyNotice: z
      .string()
      .max(5000, 'El aviso no puede pasar de 5000 caracteres.')
      .nullable()
      .transform((v) => (v === null || v.trim() === '' ? null : v.trim())),
  })
  .strict();

/** Ajustes de la corredora que se editan desde el panel. */
@Controller('v1/settings')
@UseGuards(ApiKeyGuard)
export class SettingsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async get(@CurrentTenant() tenant: Tenant): Promise<TenantSettings> {
    const { rows } = await this.pool.query<{ privacy_notice: string | null }>('SELECT privacy_notice FROM tenants WHERE id = $1', [tenant.id]);
    return { privacyNotice: rows[0]?.privacy_notice ?? null };
  }

  @Put()
  async put(@CurrentTenant() tenant: Tenant, @Body() body: unknown): Promise<TenantSettings> {
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Los ajustes no son válidos.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    await this.pool.query('UPDATE tenants SET privacy_notice = $2 WHERE id = $1', [tenant.id, parsed.data.privacyNotice]);
    return { privacyNotice: parsed.data.privacyNotice };
  }
}
