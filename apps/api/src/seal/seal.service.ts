import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { open, seal as sealSecret } from '../common/secret-box';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { StorageNotConfiguredError, StorageService } from '../storage/storage.service';
import { SealKeyMaterial, SealMeta, certificateFingerprint, generateSealKey, sealPdf } from './seal';
import { TsaError, requestTimestamp } from './tsa';

const MAX_TSA_ATTEMPTS = 12;
/** Espera (segundos) antes de reintentar el sello de tiempo, según los intentos que lleva. */
const TSA_BACKOFF_SECONDS = [30, 120, 600, 1800, 3600, 3 * 3600];
const LOCK_KEY = 7_301_003;

/** Segundos desde la firma a partir de los cuales toca el intento número `attempts` + 1. */
export function dueAfterSeconds(attempts: number): number {
  let total = 0;
  for (let i = 0; i < attempts; i++) total += TSA_BACKOFF_SECONDS[Math.min(i, TSA_BACKOFF_SECONDS.length - 1)];
  return total;
}

/** La llave de sello guardada no se puede abrir (¿cambió SECRETS_KEY?). No se reemplaza sola: eso cambiaría quién avala los PDF. */
export class SealKeyUnreadableError extends Error {
  constructor() {
    super('No se puede abrir la llave de sello guardada: ¿cambió SECRETS_KEY? Restaure la anterior; no se crea otra automáticamente.');
    this.name = 'SealKeyUnreadableError';
  }
}

export interface ServiceSeal {
  certificatePem: string;
  fingerprint: string;
}

/**
 * Llave del servicio, sellado de los PDF y sello de tiempo. La llave se crea sola la primera vez que se firma (con un
 * candado, para que dos instancias no creen dos) y se guarda cifrada con SECRETS_KEY.
 */
@Injectable()
export class SealService {
  private readonly logger = new Logger(SealService.name);
  private cached: (SealKeyMaterial & { fingerprint: string }) | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageService,
  ) {}

  get timestampEnabled(): boolean {
    return this.config.tsaUrl !== null;
  }

  private async key(): Promise<SealKeyMaterial & { fingerprint: string }> {
    if (this.cached) return this.cached;
    const secrets = this.config.secretsKey;
    if (!secrets) throw new StorageNotConfiguredError();
    const load = async () => {
      const { rows } = await this.pool.query<{ certificate_pem: string; private_key_enc: string; fingerprint_sha256: string }>(
        'SELECT certificate_pem, private_key_enc, fingerprint_sha256 FROM seal_keys WHERE active',
      );
      return rows[0];
    };
    let row = await load();
    if (!row) {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        row = await load();
        if (!row) {
          const k = generateSealKey({ commonName: 'Servicio de firma electrónica: sello de integridad', organization: 'firma-electronica-service' });
          const fingerprint = certificateFingerprint(k.certificatePem);
          await client.query('INSERT INTO seal_keys (certificate_pem, private_key_enc, fingerprint_sha256) VALUES ($1, $2, $3)', [
            k.certificatePem,
            sealSecret(secrets, 'seal-key', k.privateKeyPem),
            fingerprint,
          ]);
          this.logger.log(`Llave de sello creada (certificado ${fingerprint.slice(0, 12)}…).`);
          row = await load();
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
        client.release();
      }
    }
    let privateKeyPem: string;
    try {
      privateKeyPem = open(secrets, 'seal-key', row.private_key_enc);
    } catch {
      throw new SealKeyUnreadableError();
    }
    this.cached = { certificatePem: row.certificate_pem, privateKeyPem, fingerprint: row.fingerprint_sha256 };
    return this.cached;
  }

  /** El certificado (público) con que se sella; lo que se entrega en el paquete de evidencia para comparar su huella. */
  async certificate(): Promise<ServiceSeal> {
    const k = await this.key();
    return { certificatePem: k.certificatePem, fingerprint: k.fingerprint };
  }

  /** Sella el PDF. Devuelve el PDF sellado y la huella del certificado usado. */
  async seal(pdf: Uint8Array, meta: SealMeta): Promise<{ pdf: Buffer; certificateSha256: string }> {
    const k = await this.key();
    return { pdf: await sealPdf(pdf, k, meta), certificateSha256: k.fingerprint };
  }

  /**
   * Pide el sello de tiempo del PDF sellado y lo guarda (cifrado) junto a él. Nunca lanza: si la autoridad no responde se
   * deja constancia y `retryPending` lo reintenta. Devuelve si quedó sellado.
   */
  async stamp(requestId: string, tenantId: string, sha256: string): Promise<boolean> {
    const url = this.config.tsaUrl;
    if (!url) return false;
    try {
      const token = await requestTimestamp(url, sha256);
      const path = `${tenantId}/${requestId}/timestamp.tsr`;
      await this.storage.put(path, token.response);
      await this.pool.query('UPDATE signature_requests SET tsa_path = $2, tsa_at = $3, tsa_attempts = tsa_attempts + 1 WHERE id = $1', [requestId, path, token.genTime]);
      await this.pool.query("INSERT INTO access_log (request_id, event, detail) VALUES ($1, 'timestamped', $2)", [requestId, JSON.stringify({ at: token.genTime.toISOString() })]);
      return true;
    } catch (e) {
      const { rows } = await this.pool
        .query<{ tsa_attempts: number }>('UPDATE signature_requests SET tsa_attempts = tsa_attempts + 1 WHERE id = $1 RETURNING tsa_attempts', [requestId])
        .catch(() => ({ rows: [] as { tsa_attempts: number }[] }));
      const n = rows[0]?.tsa_attempts ?? 0;
      const reason = e instanceof TsaError ? e.message : (e as Error).message;
      this.logger.warn(`Sello de tiempo de ${requestId} (intento ${n}): ${reason}`);
      // Se deja constancia en la bitácora la primera vez y al agotar los intentos (no en cada reintento).
      if (n === 1 || n >= MAX_TSA_ATTEMPTS) {
        await this.pool
          .query("INSERT INTO access_log (request_id, event, detail) VALUES ($1, 'timestamp_failed', $2)", [requestId, JSON.stringify({ attempt: n, reason: reason.slice(0, 200) })])
          .catch(() => undefined);
      }
      return false;
    }
  }

  /**
   * Reintenta el sello de tiempo de las firmas que no lo lograron. La espera crece con los intentos (30 s, 2 min, 10 min,
   * 30 min, 1 h, 3 h y luego cada 3 h), contada desde la firma. Devuelve cuántas lo lograron.
   */
  async retryPending(limit = 20): Promise<number> {
    if (!this.config.tsaUrl) return 0;
    const { rows } = await this.pool.query<{ id: string; tenant_id: string; pdf_sha256: string; tsa_attempts: number; age: number }>(
      `SELECT id, tenant_id, pdf_sha256, tsa_attempts, extract(epoch FROM now() - signed_at)::int AS age
         FROM signature_requests
        WHERE status = 'SIGNED' AND tsa_path IS NULL AND pdf_sha256 IS NOT NULL AND tsa_attempts < $1
        ORDER BY signed_at LIMIT $2`,
      [MAX_TSA_ATTEMPTS, limit * 5],
    );
    let tried = 0;
    let ok = 0;
    for (const r of rows) {
      if (tried >= limit) break;
      if (r.age < dueAfterSeconds(r.tsa_attempts)) continue;
      tried++;
      if (await this.stamp(r.id, r.tenant_id, r.pdf_sha256)) ok++;
    }
    return ok;
  }
}
