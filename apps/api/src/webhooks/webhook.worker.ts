import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { fetch as undiciFetch, type Agent } from 'undici';
import { open } from '../common/secret-box';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_OWNER } from '../db/db.module';
import { signWebhook } from './signing';
import { assertPublicUrl, createWebhookAgent } from './ssrf';

/** Espera tras el intento n (1 = el primero): 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h. */
export const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600, 10_800, 21_600, 43_200] as const;
/** Intentos totales antes de rendirse: el primero + un reintento por cada espera. */
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

/** Mientras una entrega está en curso nadie más la toma (por si hay dos instancias o un cuelgue). */
const LEASE_SECONDS = 120;
const BATCH = 10;
const POLL_MS = 5000;
const MAX_RESPONSE_BYTES = 2048;

interface Outcome {
  status: number | null;
  error: string | null;
}

interface Due {
  id: string;
  url: string;
  payload: unknown;
  event: string;
  attempts: number;
  secret_enc: string | null;
}

/**
 * Entrega los webhooks pendientes del outbox. Un evento solo se da por entregado con un 2xx; todo lo
 * demás (error de red, 3xx, 4xx, 5xx, timeout, destino bloqueado) se reintenta con espera creciente,
 * y tras `MAX_ATTEMPTS` se marca como fallido (queda en la tabla para revisarlo). Es «al menos una
 * vez»: el host debe tolerar repetidos usando el `id` del evento.
 */
@Injectable()
export class WebhookWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WebhookWorker.name);
  private readonly agent: Agent;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    @Inject(PG_OWNER) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.agent = createWebhookAgent(config.webhookAllowPrivate);
  }

  onModuleInit(): void {
    if (!this.config.backgroundJobs) return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => this.logger.error(`Ciclo de webhooks: ${(e as Error).message}`)), POLL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
    await this.agent.close();
  }

  /** Procesa un lote de entregas vencidas. Devuelve cuántas intentó. Si ya hay un ciclo en curso, espera el mismo. */
  runOnce(): Promise<number> {
    if (!this.running) {
      this.running = this.process().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async process(): Promise<number> {
    // Se «reserva» el lote moviendo next_try_at hacia adelante: otro ciclo u otra instancia no lo repite.
    const { rows } = await this.pool.query<Due>(
      `WITH picked AS (
         SELECT d.id FROM webhook_deliveries d
          WHERE d.delivered_at IS NULL AND d.failed_at IS NULL AND d.next_try_at <= now()
          ORDER BY d.next_try_at
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
       )
       UPDATE webhook_deliveries d SET next_try_at = now() + make_interval(secs => $1)
         FROM picked, signature_requests r, tenants t
        WHERE d.id = picked.id AND r.id = d.request_id AND t.id = r.tenant_id
       RETURNING d.id, d.url, d.payload, d.event, d.attempts, t.webhook_secret_enc AS secret_enc`,
      [LEASE_SECONDS],
    );
    await Promise.allSettled(rows.map((d) => this.deliver(d)));
    return rows.length;
  }

  private async deliver(d: Due): Promise<void> {
    const attempt = d.attempts + 1;
    let outcome: Outcome;
    try {
      outcome = await this.send(d);
    } catch (e) {
      outcome = { status: null, error: (e as Error).message.slice(0, 300) };
    }
    const { status, error } = outcome;

    if (error === null) {
      await this.pool.query(
        `UPDATE webhook_deliveries SET attempts = $2, delivered_at = now(), last_status = $3, last_error = NULL WHERE id = $1`,
        [d.id, attempt, status],
      );
      return;
    }
    const giveUp = attempt >= MAX_ATTEMPTS;
    const wait = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1];
    await this.pool.query(
      `UPDATE webhook_deliveries
          SET attempts = $2, last_status = $3, last_error = $4,
              failed_at = CASE WHEN $5::boolean THEN now() ELSE NULL END,
              next_try_at = now() + make_interval(secs => $6)
        WHERE id = $1`,
      [d.id, attempt, status, error, giveUp, wait],
    );
    this.logger.warn(`Webhook ${d.id} (${d.event}) intento ${attempt}/${MAX_ATTEMPTS} falló: ${error}${giveUp ? ' — se da por fallido' : ''}`);
  }

  /** `error: null` si el receptor contestó 2xx; si no, el motivo. El estado HTTP va aparte (puede no haber). */
  private async send(d: Due): Promise<Outcome> {
    if (!d.secret_enc) return { status: null, error: 'El tenant no tiene secreto de webhook configurado (use tenant:webhook).' };
    if (!this.config.secretsKey) return { status: null, error: 'Falta SECRETS_KEY: no se puede descifrar el secreto del webhook.' };
    let secret: string;
    try {
      secret = open(this.config.secretsKey, 'webhook-secret', d.secret_enc);
    } catch {
      return { status: null, error: 'No se pudo descifrar el secreto del webhook (¿cambió SECRETS_KEY?).' };
    }

    const url = assertPublicUrl(d.url, this.config.webhookAllowPrivate);
    const body = JSON.stringify(d.payload);
    const t = Math.floor(Date.now() / 1000);

    const res = await undiciFetch(url, {
      method: 'POST',
      dispatcher: this.agent,
      // No se siguen redirecciones: una respuesta 3xx podría mandar la petición a una dirección interna.
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'firma-electronica-service/1',
        'X-Webhook-Id': d.id,
        'X-Webhook-Event': d.event,
        'X-Signature': signWebhook(secret, t, body),
      },
      body,
    });
    await drain(res);
    const status = res.status;
    if (status >= 200 && status < 300) return { status, error: null };
    if (status >= 300 && status < 400) return { status, error: `El receptor respondió ${status} (redirección): no se sigue.` };
    return { status, error: `El receptor respondió ${status}.` };
  }
}

/** Lee como máximo unos KB de la respuesta y cierra la conexión: el cuerpo no importa y no debe poder agotar memoria. */
interface Drainable {
  body: { getReader(): { read(): Promise<{ done: boolean; value?: { length: number } }>; cancel(): Promise<unknown> } } | null;
}

async function drain(res: Drainable): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  let read = 0;
  try {
    while (read < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value?.length ?? 0;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
