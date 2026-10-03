-- Esquema M0 (borrador, sin ejecutar contra una base real todavía).
-- Se convertirá en migrations/0000_inicial.sql al arrancar M1.

CREATE TYPE letter_status AS ENUM ('PENDING', 'SIGNED', 'REJECTED', 'EXPIRED', 'REVOKED');
CREATE TYPE notify_channel AS ENUM ('SMS', 'WHATSAPP', 'EMAIL');
CREATE TYPE delivery_mode AS ENUM ('SERVICE', 'HOST');

CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  country          char(2) NOT NULL,
  api_key_hash     text NOT NULL UNIQUE,
  webhook_url      text,
  webhook_secret   text NOT NULL,
  broker_legal_name text NOT NULL,
  broker_registry_code text NOT NULL,
  retention_days   integer NOT NULL DEFAULT 1825 CHECK (retention_days > 0),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Plantilla y textos legales versionados: nunca se edita una versión usada.
CREATE TABLE letter_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  version         integer NOT NULL,
  body_json       jsonb NOT NULL,   -- Anexo I: encabezado, facultades disponibles
  annex_a_text    text NOT NULL,    -- Anexo A del corredor
  clause_text     text NOT NULL,    -- cláusula de aceptación electrónica
  active          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

CREATE TABLE letters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  template_id        uuid NOT NULL REFERENCES letter_templates(id),
  reference          text NOT NULL,
  external_ref       text NOT NULL,
  idempotency_key    text,
  status             letter_status NOT NULL DEFAULT 'PENDING',
  snapshot           jsonb NOT NULL,        -- datos tal como los mandó el host
  snapshot_sha256    char(64) NOT NULL,
  otp_channel        notify_channel NOT NULL,
  otp_to             text NOT NULL,
  delivery_mode      delivery_mode NOT NULL,
  delivery_channel   notify_channel,
  delivery_to        text,
  token_hash         char(64) NOT NULL UNIQUE,
  webhook_url        text,
  expires_at         timestamptz NOT NULL,
  signed_at          timestamptz,
  pdf_path           text,
  pdf_sha256         char(64),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (delivery_mode = 'HOST' OR (delivery_channel IS NOT NULL AND delivery_to IS NOT NULL)),
  CHECK ((status = 'SIGNED') = (signed_at IS NOT NULL)),
  CHECK (status <> 'SIGNED' OR (pdf_path IS NOT NULL AND pdf_sha256 IS NOT NULL))
);
CREATE INDEX letters_pending_expiry_idx ON letters (expires_at) WHERE status = 'PENDING';

-- Desafío de la foto: código aleatorio que el cliente escribe en un papel y fotografía junto
-- al DNI. Un código emitido ahora no puede estar en una foto tomada antes de emitirse.
-- Pedir uno nuevo invalida el anterior (solo uno vivo por carta).
CREATE TABLE photo_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id     uuid NOT NULL REFERENCES letters(id),
  code          char(4) NOT NULL CHECK (code ~ '^[0-9]{4}$'),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  superseded_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE UNIQUE INDEX photo_challenges_one_live_idx
  ON photo_challenges (letter_id) WHERE consumed_at IS NULL AND superseded_at IS NULL;

CREATE TABLE letter_evidence (
  letter_id          uuid PRIMARY KEY REFERENCES letters(id),
  otp_verified_at    timestamptz NOT NULL,
  otp_attempts       integer NOT NULL,
  challenge_id       uuid REFERENCES photo_challenges(id),
  photo_received_at  timestamptz,       -- hora del SERVIDOR; el EXIF lo controla el cliente
  photo_path         text,              -- se vacía al vencer la retención
  photo_sha256       char(64) NOT NULL,
  photo_width        integer,
  photo_height       integer,
  powers_json        jsonb NOT NULL,    -- facultades marcadas + observación
  clause_text        text NOT NULL,     -- texto exacto mostrado al cliente
  ip                 inet NOT NULL,
  user_agent         text NOT NULL,
  client_info        jsonb,
  captured_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id     uuid NOT NULL REFERENCES letters(id),
  code_hash     char(64) NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE access_log (
  id          bigserial PRIMARY KEY,
  letter_id   uuid REFERENCES letters(id),
  event       text NOT NULL,            -- link_opened, otp_sent, otp_failed, signed, ...
  ip          inet,
  user_agent  text,
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id     uuid NOT NULL REFERENCES letters(id),
  event         text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  next_try_at   timestamptz,
  delivered_at  timestamptz,
  last_status   integer
);

-- RLS: el rol de runtime solo ve las filas de su tenant (tablas con tenant_id).
-- Detalle de políticas se define en M1 junto con el rol de runtime.
