import type { INestApplication } from '@nestjs/common';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG, AppConfig } from './config/config';

/**
 * Política de contenido del panel y de la página de firma. Todo es del mismo origen salvo las imágenes
 * y el video de la cámara, que son `blob:` locales. `frame-ancestors 'none'` impide incrustar la página
 * de firma en otra (clickjacking); `connect-src 'self'` impide que un script mande datos a otro sitio.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Configuración de la aplicación HTTP que NO es un módulo. Vive aparte de `main.ts` para que las
 * pruebas de integración la ejecuten igual que producción: lo que no pasa por acá no se prueba.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);

  // La IP que se guarda como evidencia (y con la que se limita) debe ser la del firmante, no la del
  // proxy que está delante (el túnel de Cloudflare).
  if (config.trustProxy !== null) {
    app.getHttpAdapter().getInstance().set('trust proxy', config.trustProxy);
  }

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // El token de firma viaja en la URL de la página: que no salga en el encabezado Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // La cámara solo para esta página; nada de micrófono ni ubicación.
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  // Las respuestas de la API llevan links de firma, códigos y datos del firmante: nada de cachés
  // intermedias. Solo para /v1: los archivos del panel necesitan su propia caché.
  app.use('/v1', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  serveWeb(app, config.webDistDir);
}

/**
 * Sirve el panel compilado (`apps/web/dist`) desde la misma API: un solo proceso, un solo puerto y una
 * sola ruta de túnel. Si no hay panel compilado no se hace nada y la API funciona igual.
 */
function serveWeb(app: INestApplication, dist: string | null): void {
  if (!dist || !existsSync(join(dist, 'index.html'))) return;

  // Los archivos del build llevan el hash en el nombre (assets/index-abc123.js): se pueden cachear un
  // año porque un cambio genera otro nombre. `index.html` NO: debe revalidarse para ver los cambios.
  app.use(
    express.static(dist, {
      index: false,
      maxAge: '1y',
      immutable: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  // Rutas del panel y de la página de firma (/solicitudes, /s/<token>…): todas las sirve la misma SPA.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/v1' || req.path.startsWith('/v1/')) return next(); // la API responde lo suyo, 404 incluido
    // Un archivo que no existe (/assets/viejo.js) debe dar 404, no una página HTML que el navegador
    // intentaría ejecutar como script.
    if (/\.[a-z0-9]{1,8}$/i.test(req.path)) return next();
    if (!req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(dist, 'index.html'));
  });
}
