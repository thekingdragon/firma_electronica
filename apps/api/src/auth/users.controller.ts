import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AccessGuard, CurrentUser, Roles } from './access.guard';
import { parseBody } from './auth.controller';
import type { SessionUser } from './session';
import { AuthLogService } from './auth-log.service';
import { UsersService } from './users.service';

const createSchema = z
  .object({
    email: z.string().trim().min(3).max(200),
    name: z.string().trim().min(1).max(120),
    role: z.enum(['ADMIN', 'REVIEWER']),
  })
  .strict();
const updateSchema = z.object({ role: z.enum(['ADMIN', 'REVIEWER']).optional(), active: z.boolean().optional() }).strict();

/** Usuarios de la corredora. Solo un administrador con SESIÓN (la clave de API de integración no gestiona personas). */
@Controller('v1/users')
@UseGuards(AccessGuard)
@Roles('ADMIN')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly authLog: AuthLogService,
  ) {}

  @Get()
  async list(@CurrentUser() me: SessionUser) {
    return { users: await this.users.list(me.tenantId as string) };
  }

  /** Los accesos y cambios de usuarios de ESTA corredora, los más recientes primero (máximo 200). */
  @Get('events')
  async events(@CurrentUser() me: SessionUser, @Query('limit') limit?: string) {
    return { events: await this.authLog.recent({ tenantId: me.tenantId as string, limit: limit ? Number(limit) : 100 }) };
  }

  /** La contraseña provisional se devuelve UNA vez; la persona debe cambiarla al entrar. */
  @Post()
  create(@CurrentUser() me: SessionUser, @Body() body: unknown) {
    return this.users.create(me.tenantId as string, me.id, parseBody(createSchema, body, 'Los datos del usuario no son válidos.'));
  }

  @Patch(':id')
  @HttpCode(204)
  async update(@CurrentUser() me: SessionUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown): Promise<void> {
    await this.users.update(me.tenantId as string, me.id, id, parseBody(updateSchema, body));
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(@CurrentUser() me: SessionUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.resetPassword(me.tenantId as string, me.id, id);
  }

  @Post(':id/reset-mfa')
  @HttpCode(204)
  async resetMfa(@CurrentUser() me: SessionUser, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.users.resetMfa(me.tenantId as string, me.id, id);
  }
}
