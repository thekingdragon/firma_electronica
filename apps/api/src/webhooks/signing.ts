import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firma de un webhook: HMAC-SHA256 de `"<timestamp>.<cuerpo>"` con el secreto del tenant, en el
 * formato `t=<unix>,v1=<hex>`. Incluir el timestamp dentro de lo firmado permite al receptor rechazar
 * un mensaje viejo que alguien capturó y reenvía (ataque de repetición).
 */
export function signWebhook(secret: string, timestampSec: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

/**
 * Verificación de referencia, la que debe hacer el HOST al recibir un webhook. Se incluye aquí para
 * documentar el contrato y probarlo; el host la reimplementa en su lenguaje.
 */
export function verifyWebhook(
  secret: string,
  header: string,
  body: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  const { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = opts;
  const parts = new Map(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isInteger(t) || !v1) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;

  const expected = Buffer.from(signWebhook(secret, t, body).split('v1=')[1], 'hex');
  const given = Buffer.from(v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
