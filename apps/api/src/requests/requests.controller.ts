import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from '../common/api-error';
import { ApiKeyGuard, CurrentTenant } from '../tenants/api-key.guard';
import type { Tenant } from '../tenants/tenants.service';
import { REQUEST_STATUSES, RequestStatus } from './request-status';
import { RequestsService, SignatureRequestSummary, SignatureRequestView } from './requests.service';

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

  @Get()
  async list(
    @CurrentTenant() tenant: Tenant,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: SignatureRequestSummary[] }> {
    if (status !== undefined && !(REQUEST_STATUSES as readonly string[]).includes(status)) {
      throw new ApiError(422, 'VALIDATION_ERROR', `status debe ser uno de: ${REQUEST_STATUSES.join(', ')}.`);
    }
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'limit debe ser un entero entre 1 y 100.');
    }
    return { items: await this.requests.list(tenant, { status: status as RequestStatus | undefined, limit: n }) };
  }

  @Get(':id')
  get(@CurrentTenant() tenant: Tenant, @Param('id') id: string): Promise<SignatureRequestSummary> {
    return this.requests.get(tenant, id);
  }
}
