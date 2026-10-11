import { Body, Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/access.guard';
import { ApiError } from '../common/api-error';
import { ApiKeyGuard, CurrentTenant } from './api-key.guard';
import { TemplateDetail, TemplateListItem, TemplatesApiService } from './templates.api';
import type { PublishedTemplate } from './templates.service';
import type { Tenant } from './tenants.service';

/**
 * Plantillas de los documentos de cada corredora, editables desde el panel. Una versión publicada no se
 * edita: publicar crea una versión nueva y la deja activa (las solicitudes ya creadas conservan la suya).
 */
@Controller('v1/templates')
@UseGuards(ApiKeyGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesApiService) {}

  @Get()
  list(@CurrentTenant() tenant: Tenant): Promise<{ items: TemplateListItem[] }> {
    return this.templates.list(tenant);
  }

  @Get(':documentType')
  active(@CurrentTenant() tenant: Tenant, @Param('documentType') documentType: string): Promise<TemplateDetail> {
    return this.templates.get(tenant, documentType);
  }

  @Get(':documentType/versions/:version')
  version(
    @CurrentTenant() tenant: Tenant,
    @Param('documentType') documentType: string,
    @Param('version') version: string,
  ): Promise<TemplateDetail> {
    const n = Number(version);
    if (!Number.isInteger(n) || n < 1) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Plantilla no encontrada.');
    return this.templates.get(tenant, documentType, n);
  }

  @Post(':documentType/preview')
  @Roles('ADMIN')
  @HttpCode(200)
  async preview(
    @CurrentTenant() tenant: Tenant,
    @Param('documentType') documentType: string,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const pdf = await this.templates.preview(tenant, documentType, body);
    res.status(200).set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="vista-previa.pdf"', 'X-Content-Type-Options': 'nosniff' }).send(pdf);
  }

  @Post(':documentType')
  @Roles('ADMIN')
  @HttpCode(201)
  publish(
    @CurrentTenant() tenant: Tenant,
    @Param('documentType') documentType: string,
    @Body() body: unknown,
  ): Promise<PublishedTemplate> {
    return this.templates.publish(tenant, documentType, body);
  }
}
