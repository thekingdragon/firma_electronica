-- 0004: webhook al host (outbox), revisión humana de la evidencia y retención de fotos.

-- Secreto del webhook CIFRADO. Hasta ahora estaba en claro en `tenants.webhook_secret`; se reemplaza.
-- Un tenant sin secreto no recibe webhooks hasta que se le configure uno (`tenant:webhook`). Antes de
-- producción no hay tenants reales, así que no hay datos que migrar.
ALTER TABLE tenants ADD COLUMN webhook_secret_enc text;
ALTER TABLE tenants DROP COLUMN webhook_secret;

-- Outbox de webhooks: el evento se registra en la MISMA transacción que el cambio que lo causa (firma,
-- revocación, vencimiento), y un proceso aparte lo entrega con reintentos. Así un fallo de red o un
-- reinicio no pierde eventos, ni se emite uno por un cambio que luego se deshizo.
-- `url` y `payload` quedan congelados al encolar: reintentar entrega siempre el mismo cuerpo.
ALTER TABLE webhook_deliveries
  ADD COLUMN url        text NOT NULL,
  ADD COLUMN payload    jsonb NOT NULL,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN failed_at  timestamptz,
  ADD COLUMN last_error text,
  ALTER COLUMN next_try_at SET DEFAULT now(),
  ALTER COLUMN next_try_at SET NOT NULL,
  ADD CONSTRAINT webhook_deliveries_outcome_chk CHECK (delivered_at IS NULL OR failed_at IS NULL);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_try_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;

-- Revisión humana (fase 1): alguien del corredor mira la foto y el código del desafío y dice si la
-- identidad le convence. La firma sigue siendo válida como acto del firmante; esto es el dictamen del
-- corredor sobre la evidencia. `reviewed_by` es un nombre libre: el panel todavía no tiene usuarios.
ALTER TABLE signature_evidence
  ADD COLUMN review_result text CHECK (review_result IN ('VERIFIED', 'REJECTED')),
  ADD COLUMN reviewed_at   timestamptz,
  ADD COLUMN reviewed_by   text,
  ADD COLUMN review_note   text,
  ADD CONSTRAINT signature_evidence_review_chk
    CHECK ((review_result IS NULL) = (reviewed_at IS NULL) AND (review_result IS NULL) = (reviewed_by IS NULL));

-- Retención: al vencer el plazo del tenant se borra el ARCHIVO de la foto y se conservan los hashes.
-- `photo_deleted_at` deja constancia de que no es un olvido.
ALTER TABLE signature_evidence ADD COLUMN photo_deleted_at timestamptz;
