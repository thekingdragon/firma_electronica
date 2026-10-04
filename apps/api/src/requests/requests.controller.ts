import { Body, Controller, Headers, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard, CurrentTenant } from '../tenants/api-key.guard';
import type { Tenant } from '../tenants/tenants.service';
import { RequestsService, SignatureRequestView } from './requests.service';

@Controller('v1/requests')
@UseGuards(ApiKeyGuard)
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Post()
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: Tenant,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignatureRequestView> {
    const input = this.requests.parseBody(body);
    const { view, replay } = await this.requests.create(tenant, input, idempotencyKey);
    // Un replay devuelve la misma solicitud con 200: el host distingue «creada» de «ya existía».
    if (replay) res.status(200);
    return view;
  }
}
