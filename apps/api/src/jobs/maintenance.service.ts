import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { StorageService } from '../storage/storage.service';
import { enqueueWebhook } from '../webhooks/outbox';

/** Claves de los candados de PostgreSQL: dos instancias del servicio no deben hacer la misma tarea a la vez. */
const LOCK_EXPIRE = 7_301_001;
const LOCK_PURGE = 7_301_002;

const EXPIRE_EVERY_MS = 60_000;
const PURGE_EVERY_MS = 6 * 60 * 60_000;
const PURGE_BATCH = 100;

/**
 * Tareas periódicas:
 *
 * - **Vencer**: una solicitud PENDING cuyo `expires_at` pasó se marca EXPIRED y se avisa al host.
 *   El link ya deja de abrir por la fecha (se comprueba al abrirlo); esta tarea es para que el ESTADO
 *   y el aviso reflejen la realidad.
 * - **Retención**: pasado el plazo del tenant (`retention_days`, contado desde la firma) se borra el
 *   ARCHIVO de la foto de verificación y se conservan sus huellas (hash) y la constancia.
 *   **Ojo:** el PDF firmado lleva la foto incrustada y NO se toca (alterarlo rompería su hash y su
 *   valor como constancia). Si la retención debe alcanzar también esa copia, es una decisión legal
 *   pendiente (ver ARQUITECTURA §13).
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceService.name);
  private timers: NodeJS.Timeout[] = [];
  private inFlight = new Set<Promise<unknown>>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    if (!this.config.backgroundJobs) return;
    const every = (ms: number, fn: () => Promise<number>, name: string) => {
      const t = setInterval(() => this.track(fn().catch((e) => this.logger.error(`${name}: ${(e as Error).message}`))), ms);
      t.unref();
      this.timers.push(t);
    };
    every(EXPIRE_EVERY_MS, () => this.expireOverdue(), 'Vencimiento');
    every(PURGE_EVERY_MS, () => this.purgeExpiredPhotos(), 'Retención');
  }

  async onApplicationShutdown(): Promise<void> {
    this.timers.forEach(clearInterval);
    await Promise.allSettled([...this.inFlight]);
  }

  private track(p: Promise<unknown>): void {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  /** Marca como vencidas las solicitudes pendientes pasadas de fecha. Devuelve cuántas. */
  async expireOverdue(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK_EXPIRE]);
      if (!lock.rows[0].ok) {
        await client.query('ROLLBACK');
        return 0;
      }
      const { rows } = await client.query<{ id: string }>(
        `UPDATE signature_requests SET status = 'EXPIRED'
          WHERE status = 'PENDING' AND expires_at <= now() RETURNING id`,
      );
      for (const { id } of rows) {
        await client.query(`INSERT INTO access_log (request_id, event) VALUES ($1, 'expired')`, [id]);
        await enqueueWebhook(client, id, 'signature.expired');
      }
      await client.query('COMMIT');
      if (rows.length) this.logger.log(`${rows.length} solicitud(es) marcada(s) como vencida(s).`);
      return rows.length;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Borra los archivos de foto cuyo plazo de retención venció. Devuelve cuántos. */
  async purgeExpiredPhotos(): Promise<number> {
    const lockClient = await this.pool.connect();
    try {
      const lock = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_PURGE]);
      if (!lock.rows[0].ok) return 0;
      try {
        const { rows } = await this.pool.query<{ request_id: string; photo_path: string | null; id_photo_path: string | null; id_back_path: string | null }>(
          `SELECT e.request_id, e.photo_path, e.id_photo_path, e.id_back_path
             FROM signature_evidence e
             JOIN signature_requests r ON r.id = e.request_id
             JOIN tenants t ON t.id = r.tenant_id
            WHERE (e.photo_path IS NOT NULL OR e.id_photo_path IS NOT NULL OR e.id_back_path IS NOT NULL)
              AND r.signed_at + make_interval(days => t.retention_days) <= now()
            ORDER BY r.signed_at
            LIMIT ${PURGE_BATCH}`,
        );
        let purged = 0;
        for (const row of rows) {
          // Primero el archivo, después la fila: si algo falla en medio, la próxima corrida lo termina
          // (borrar un archivo que ya no está no es un error).
          if (row.photo_path) await this.storage.remove(row.photo_path);
          if (row.id_photo_path) await this.storage.remove(row.id_photo_path);
          if (row.id_back_path) await this.storage.remove(row.id_back_path);
          const upd = await this.pool.query(
            `UPDATE signature_evidence SET photo_path = NULL, id_photo_path = NULL, id_back_path = NULL, photo_deleted_at = now()
              WHERE request_id = $1 AND photo_path IS NOT DISTINCT FROM $2 AND id_photo_path IS NOT DISTINCT FROM $3
                AND id_back_path IS NOT DISTINCT FROM $4`,
            [row.request_id, row.photo_path, row.id_photo_path, row.id_back_path],
          );
          if (upd.rowCount) {
            await this.pool.query(`INSERT INTO access_log (request_id, event) VALUES ($1, 'photo_purged')`, [row.request_id]);
            purged++;
          }
        }
        if (purged) this.logger.log(`${purged} foto(s) borrada(s) por vencer su plazo de retención.`);
        return purged;
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_PURGE]);
      }
    } finally {
      lockClient.release();
    }
  }
}
