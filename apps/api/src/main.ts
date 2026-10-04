import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get<AppConfig>(APP_CONFIG);

  // La IP que se guarda como evidencia debe ser la del firmante, no la del proxy que está delante.
  if (config.trustProxy !== null) app.getHttpAdapter().getInstance().set('trust proxy', config.trustProxy);

  // Las respuestas llevan links de firma, códigos y datos del firmante: nada de cachés intermedias.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
}
bootstrap();
