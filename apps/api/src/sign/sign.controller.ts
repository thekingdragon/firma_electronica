import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ClientContext, SignIntro, SigningView, SignService } from './sign.service';

const ctxOf = (req: Request): ClientContext => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

/** Endpoints públicos: se protegen con el token del link, el OTP y la sesión; no con clave de API. */
@Controller('v1/sign/:token')
export class SignController {
  constructor(private readonly sign: SignService) {}

  @Get()
  intro(@Param('token') token: string, @Req() req: Request): Promise<SignIntro> {
    return this.sign.intro(token, ctxOf(req));
  }

  @Post('otp')
  @HttpCode(200)
  otp(@Param('token') token: string, @Req() req: Request) {
    return this.sign.requestOtp(token, ctxOf(req));
  }

  @Post('verify')
  @HttpCode(200)
  verify(@Param('token') token: string, @Body() body: { code?: unknown } | undefined, @Req() req: Request) {
    const code = typeof body?.code === 'string' ? body.code : undefined;
    return this.sign.verify(token, code, ctxOf(req));
  }

  @Get('view')
  view(@Param('token') token: string, @Headers('x-session') session: string | undefined): Promise<SigningView> {
    return this.sign.view(token, session);
  }
}
