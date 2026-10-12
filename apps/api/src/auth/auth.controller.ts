import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { RateLimitService } from '../common/rate-limit';
import { PG_OWNER } from '../db/db.module';
import { AccessGuard, AllowMustChange, CurrentUser } from './access.guard';
import { AuthService, IssuedSession } from './auth.service';
import { MfaService } from './mfa.service';
import { PasswordResetService } from './password-reset.service';
import { REFRESH_COOKIE, readCookie, refreshCookieOptions } from './refresh-cookie';
import type { SessionUser } from './session';

const loginSchema = z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200) }).strict();
const pendingSchema = z.object({ pendingToken: z.string().min(10).max(2000) });
const verifySchema = pendingSchema.extend({ code: z.string().max(20).optional(), recoveryCode: z.string().max(30).optional() }).strict();
const enablePendingSchema = pendingSchema.extend({ code: z.string().min(6).max(10) }).strict();
const codeSchema = z.object({ code: z.string().min(6).max(10) }).strict();
const disableSchema = z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(10) }).strict();
const changeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }).strict();
const resetRequestSchema = z.object({ email: z.string().min(3).max(200) }).strict();
const resetCompleteSchema = z.object({ token: z.string().min(10).max(200), newPassword: z.string().min(1).max(200) }).strict();

export function parseBody<T>(schema: z.ZodType<T>, body: unknown, message = 'Los datos no son válidos.'): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(422, 'VALIDATION_ERROR', message, { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(PG_OWNER) private readonly pool: Pool,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly resets: PasswordResetService,
    private readonly limits: RateLimitService,
  ) {}

  /** La respuesta de una sesión: el access token va en el cuerpo; el refresh, SOLO en cookie HttpOnly. */
  private async session(res: Response, s: IssuedSession) {
    if (s.refreshToken) res.cookie(REFRESH_COOKIE, s.refreshToken, refreshCookieOptions());
    return { status: 'ok' as const, accessToken: s.accessToken, expiresInSeconds: s.expiresInSeconds, ...(await this.profile(s.user)) };
  }

  private async profile(user: SessionUser) {
    const tenant = user.tenantId ? (await this.pool.query<{ name: string; legal_name: string; timezone: string }>('SELECT name, legal_name, timezone FROM tenants WHERE id = $1', [user.tenantId])).rows[0] : null;
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword, mfaEnabled: user.mfaEnabled }, tenant: tenant ? { name: tenant.name, legalName: tenant.legal_name, timezone: tenant.timezone } : null };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limits.checkPublic(req.ip ?? 'desconocida', 'verify', res);
    const { email, password } = parseBody(loginSchema, body);
    const r = await this.auth.login(email, password, req.ip, Boolean(req.header('cf-connecting-ip')));
    if (r.status === 'ok') return this.session(res, r.session);
    return r;
  }

  @Post('mfa/verify')
  @HttpCode(200)
  async verify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limits.checkPublic(req.ip ?? 'desconocida', 'verify', res);
    const b = parseBody(verifySchema, body);
    if (!b.code && !b.recoveryCode) throw new ApiError(422, 'VALIDATION_ERROR', 'Indique el código.');
    return this.session(res, await this.mfa.verify(b.pendingToken, b, req.ip));
  }

  /** Operador que debe activar el segundo factor al entrar por primera vez (aún sin sesión: solo testigo intermedio). */
  @Post('mfa/setup-pending')
  @HttpCode(200)
  setupPending(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limits.checkPublic(req.ip ?? 'desconocida', 'verify', res);
    return this.mfa.setup(this.mfa.pendingUser(parseBody(pendingSchema, body).pendingToken, 'setup'));
  }

  @Post('mfa/enable-pending')
  @HttpCode(200)
  async enablePending(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limits.checkPublic(req.ip ?? 'desconocida', 'verify', res);
    const b = parseBody(enablePendingSchema, body);
    const r = await this.mfa.enableFromPending(b.pendingToken, b.code, req.ip);
    return { ...(await this.session(res, r.session)), recoveryCodes: r.recoveryCodes };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limits.checkPublic(req.ip ?? 'desconocida', 'default', res);
    const token = readCookie(req, REFRESH_COOKIE);
    if (!token) throw new ApiError(401, 'INVALID_SESSION', 'No hay sesión.');
    try {
      return await this.session(res, await this.auth.refresh(token, req.ip));
    } catch (e) {
      // Una cookie que ya no sirve se borra, para no reintentarla en cada carga de la página.
      res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
      throw e;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readCookie(req, REFRESH_COOKIE));
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
  }

  @Get('me')
  @UseGuards(AccessGuard)
  @AllowMustChange()
  async me(@CurrentUser() user: SessionUser) {
    return this.profile(user);
  }

  @Post('password/change')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  @AllowMustChange()
  async change(@CurrentUser() user: SessionUser, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = parseBody(changeSchema, body);
    return this.session(res, await this.auth.changePassword(user.id, b.currentPassword, b.newPassword, req.ip));
  }

  @Post('password-reset/request')
  @HttpCode(202)
  async resetRequest(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limits.checkPublic(req.ip ?? 'desconocida', 'otp', res);
    await this.resets.request(parseBody(resetRequestSchema, body).email);
    return { message: 'Si el correo está registrado, le enviamos un enlace para elegir una contraseña nueva.' };
  }

  @Post('password-reset/complete')
  @HttpCode(204)
  async resetComplete(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.limits.checkPublic(req.ip ?? 'desconocida', 'verify', res);
    const b = parseBody(resetCompleteSchema, body);
    await this.resets.complete(b.token, b.newPassword);
  }

  // ---- Segundo factor del usuario con sesión

  @Post('mfa/setup')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  setup(@CurrentUser() user: SessionUser) {
    return this.mfa.setup(user.id);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  enable(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.mfa.enable(user.id, parseBody(codeSchema, body).code);
  }

  @Post('mfa/disable')
  @HttpCode(204)
  @UseGuards(AccessGuard)
  async disable(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<void> {
    const b = parseBody(disableSchema, body);
    await this.mfa.disable(user.id, b.password, b.code);
  }
}
