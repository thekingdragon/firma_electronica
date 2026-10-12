import { Body, Controller, Get, HttpCode, Logger, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { esZonaValida } from '../common/fechas';
import { OperatorGuard } from './operator.guard';
import { OperatorService } from './operator.service';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    legalName: z.string().trim().min(1).max(200),
    country: z.string().regex(/^[A-Za-z]{2}$/, 'Use un código de 2 letras (ej. PE).'),
    registryCode: z.string().trim().max(60).optional().nullable(),
    webhookUrl: z.url().optional().nullable(),
    timezone: z.string().refine(esZonaValida, 'Elija una zona horaria válida (p. ej. America/Lima).').optional(),
    adminEmail: z.string().trim().min(3).max(200).optional(),
    adminName: z.string().trim().max(120).optional(),
  })
  .strict();
const adminSchema = z.object({ email: z.string().trim().min(3).max(200), name: z.string().trim().min(1).max(120) }).strict();
const activeSchema = z.object({ active: z.boolean() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', message, { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

/** Panel de operador: lo que ve y hace quien administra el servicio entero, por encima de cada corredora. */
@Controller('v1/operator')
@UseGuards(OperatorGuard)
export class OperatorController {
  private readonly logger = new Logger('Operador');
  constructor(private readonly operator: OperatorService) {}

  /** Sirve también para validar la clave al conectarse. */
  @Get('overview')
  overview() {
    return this.operator.overview();
  }

  @Get('tenants')
  async tenants() {
    return { tenants: await this.operator.tenants() };
  }

  /** Alta de una corredora. La clave de API se devuelve UNA vez: en la base solo queda su hash. */
  @Post('tenants')
  async create(@Body() body: unknown) {
    const input = parse(createSchema, body, 'Los datos de la corredora no son válidos.');
    const created = await this.operator.create(input);
    this.logger.warn(`Corredora creada: ${created.tenant.name} (${created.tenant.id})`);
    return created;
  }

  /** Nuevo administrador de una corredora; la contraseña provisional se devuelve UNA vez. */
  @Post('tenants/:id/admin')
  async addAdmin(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const b = parse(adminSchema, body, 'Indique correo y nombre.');
    this.logger.warn(`Administrador agregado a la corredora ${id}: ${b.email}`);
    return this.operator.addAdmin(id, b.email, b.name);
  }

  @Post('tenants/:id/active')
  @HttpCode(200)
  async setActive(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const { active } = parse(activeSchema, body, 'Indique active: true o false.');
    await this.operator.setActive(id, active);
    this.logger.warn(`Corredora ${id} ${active ? 'activada' : 'DESACTIVADA'}`);
    return { id, active };
  }

  /** Revisa las últimas 100 firmas de la corredora (PDF, sello, sello de tiempo, bitácora). */
  @Post('tenants/:id/verify')
  @HttpCode(200)
  verify(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.operator.verify(id, 100);
  }
}
