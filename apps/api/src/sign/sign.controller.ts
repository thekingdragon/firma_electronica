import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { PublicRateLimitGuard, RateBucketOf } from '../common/rate-limit';
import { PHOTO_POLICY } from './photo';
import { ClientContext, SignIntro, SigningView, SignService } from './sign.service';
import { SubmitResult, SubmitService } from './submit.service';

const ctxOf = (req: Request): ClientContext => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

/** Endpoints públicos: se protegen con el token del link, el OTP y la sesión; no con clave de API. */
@Controller('v1/sign/:token')
@UseGuards(PublicRateLimitGuard)
export class SignController {
  constructor(
    private readonly sign: SignService,
    private readonly submitService: SubmitService,
  ) {}

  @Get()
  intro(@Param('token') token: string, @Req() req: Request): Promise<SignIntro> {
    return this.sign.intro(token, ctxOf(req));
  }

  @Post('otp')
  @RateBucketOf('otp')
  @HttpCode(200)
  otp(@Param('token') token: string, @Req() req: Request) {
    return this.sign.requestOtp(token, ctxOf(req));
  }

  @Post('verify')
  @RateBucketOf('verify')
  @HttpCode(200)
  verify(@Param('token') token: string, @Body() body: { code?: unknown } | undefined, @Req() req: Request) {
    const code = typeof body?.code === 'string' ? body.code : undefined;
    return this.sign.verify(token, code, ctxOf(req));
  }

  @Get('view')
  view(@Param('token') token: string, @Headers('x-session') session: string | undefined): Promise<SigningView> {
    return this.sign.view(token, session);
  }

  @Post('photo-challenge')
  @RateBucketOf('challenge')
  @HttpCode(200)
  photoChallenge(@Param('token') token: string, @Headers('x-session') session: string | undefined, @Req() req: Request) {
    return this.submitService.issueChallenge(token, session, ctxOf(req));
  }

  @Post('submit')
  @RateBucketOf('submit')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: memoryStorage(),
      // Un archivo, de tamaño acotado: lo que llega por la red no es de fiar.
      limits: { fileSize: PHOTO_POLICY.maxBytes, files: 1, fields: 10, fieldSize: 20_000 },
    }),
  )
  submit(
    @Param('token') token: string,
    @Headers('x-session') session: string | undefined,
    @UploadedFile() photo: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: Request,
  ): Promise<SubmitResult> {
    return this.submitService.submit(
      token,
      session,
      {
        photo: photo?.buffer,
        challengeId: typeof body?.challengeId === 'string' ? body.challengeId : undefined,
        accepted: body?.accepted,
        form: body?.form,
        clientInfo: body?.clientInfo,
      },
      ctxOf(req),
    );
  }

  /** Copia firmada para el firmante: se pide con su sesión; el navegador la baja con fetch. */
  @Get('document')
  async document(
    @Param('token') token: string,
    @Headers('x-session') session: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { pdf, filename } = await this.submitService.signedDocument(token, session);
    res
      .status(200)
      .setHeader('Content-Type', 'application/pdf')
      .setHeader('Content-Disposition', `inline; filename="${filename}"`)
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(pdf);
  }
}
