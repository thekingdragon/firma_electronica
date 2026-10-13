import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Roles } from '../auth/access.guard';
import type { SessionUser } from '../auth/session';
import { ApiError } from '../common/api-error';
import { ApiKeyGuard, CurrentTenant } from '../tenants/api-key.guard';
import type { Tenant } from '../tenants/tenants.service';
import { EvidencePackageService } from './evidence-package.service';
import { EvidenceView, RequestActionsService } from './request-actions.service';
import { REQUEST_STATUSES, RequestStatus } from './request-status';
import { RequestsService, SignatureRequestSummary, SignatureRequestView } from './requests.service';

@Controller('v1/requests')
@UseGuards(ApiKeyGuard)
export class RequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly actions: RequestActionsService,
    private readonly evidencePackage: EvidencePackageService,
  ) {}

  @Post()
  @Roles('ADMIN')
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: Tenant,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { user?: SessionUser },
  ): Promise<SignatureRequestView> {
    const input = this.requests.parseBody(body);
    // Quién atendió: con sesión, SIEMPRE quien la tiene (no se puede falsear desde el cuerpo); con clave de API, lo que informe el host.
    const attendedBy = req.user ? req.user.name : (input.attendedBy ?? null);
    const { view, replay } = await this.requests.create(tenant, input, idempotencyKey, attendedBy);
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

  /** Revoca una solicitud pendiente: el link deja de abrir. Avisa al host (signature.revoked). */
  @Post(':id/revoke')
  @Roles('ADMIN')
  @HttpCode(200)
  revoke(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    return this.actions.revoke(tenant, id);
  }

  /** Elimina las fotos de una firma a pedido de su titular (cancelación de datos). El PDF firmado no se toca. */
  @Post(':id/purge-photos')
  @Roles('ADMIN')
  @HttpCode(200)
  purgePhotos(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Body() body: unknown, @Req() req: Request & { user?: SessionUser }) {
    const by = req.user ? `${req.user.name} <${req.user.email}>` : 'clave de API';
    return this.actions.purgePhotos(tenant, id, by, body);
  }

  /** Todo lo registrado de una firma, para la revisión humana. */
  @Get(':id/evidence')
  evidence(@CurrentTenant() tenant: Tenant, @Param('id') id: string): Promise<EvidenceView> {
    return this.actions.evidence(tenant, id);
  }

  /** Dictamen del corredor sobre la evidencia (VERIFIED o REJECTED). Avisa al host (signature.reviewed). */
  @Post(':id/review')
  @HttpCode(200)
  review(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Body() body: unknown, @Req() req: Request & { user?: SessionUser }) {
    // Con sesión, quien dictamina es quien entró: no se acepta un nombre escrito a mano (la bitácora puede probar quién fue).
    const input = req.user && body && typeof body === 'object' ? { ...(body as object), reviewedBy: `${req.user.name} <${req.user.email}>` } : body;
    return this.actions.review(tenant, id, input);
  }

  @Get(':id/document')
  async document(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.sendFile(res, await this.requests.getFile(tenant, id, 'document'));
  }

  /** Todo lo que prueba la firma, en un ZIP que se verifica sin este servicio. */
  @Get(':id/evidence-package')
  async evidenceZip(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Res() res: Response): Promise<void> {
    const pkg = await this.evidencePackage.build(tenant, id);
    res
      .status(200)
      .set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${pkg.filename}"`,
        'X-Content-Type-Options': 'nosniff',
      })
      .send(pkg.bytes);
  }

  @Get(':id/id-photo-back')
  async idPhotoBack(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.sendFile(res, await this.requests.getFile(tenant, id, 'idPhotoBack'));
  }

  @Get(':id/id-photo')
  async idPhoto(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.sendFile(res, await this.requests.getFile(tenant, id, 'idPhoto'));
  }

  @Get(':id/photo')
  async photo(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.sendFile(res, await this.requests.getFile(tenant, id, 'photo'));
  }

  private sendFile(res: Response, f: { bytes: Buffer; contentType: string; filename: string }): void {
    res
      .status(200)
      .setHeader('Content-Type', f.contentType)
      .setHeader('Content-Disposition', `inline; filename="${f.filename}"`)
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(f.bytes);
  }

  @Get(':id')
  get(@CurrentTenant() tenant: Tenant, @Param('id') id: string): Promise<SignatureRequestSummary> {
    return this.requests.get(tenant, id);
  }
}
