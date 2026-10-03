-- Esquema M0 (borrador, sin ejecutar contra una base real todavía).
-- Se convertirá en migrations/0000_inicial.sql al arrancar M1.
-- Modelo genérico: una solicitud de firma (signature_requests) de un tipo de documento.

CREATE TYPE request_status AS ENUM ('PENDING', 'SIGNED', 'REJECTED', 'EXPIRED', 'REVOKED');
CREATE TYPE notify_channel AS ENUM ('SMS', 'WHATSAPP', 'EMAIL');
CREATE TYPE delivery_mode AS ENUM ('SERVICE', 'HOST');

-- Tipos de documento que el servicio sabe firmar. Agregar uno es insertar una fila y definir su
-- plantilla; la primera es la carta de nombramiento del corredor (modelo SBS, Anexo I y A).
CREATE TABLE document_types (
  code  text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name  text NOT NULL
);
INSERT INTO document_types (code, name) VALUES ('APPOINTMENT_LETTER', 'Carta de nombramiento');

CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  country          char(2) NOT NULL,
  api_key_hash     text NOT NULL UNIQUE,
  webhook_url      text,
  webhook_secret   text NOT NULL,
  legal_name       text NOT NULL,   -- razón social de quien emite (p. ej. el corredor)
  registry_code    text,            -- código de registro ante el regulador, si aplica
  retention_days   integer NOT NULL DEFAULT 1825 CHECK (retention_days > 0),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Plantilla, textos legales y política de evidencia, por tenant y tipo de documento.
-- Versionada: nunca se edita una versión usada, se crea otra.
CREATE TABLE document_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  document_type   text NOT NULL REFERENCES document_types(code),
  version         integer NOT NULL,
  body_json       jsonb NOT NULL,   -- contenido del documento y esquema del formulario (en la
                                    -- carta: encabezado y facultades disponibles)
  annex_text      text,             -- anexo obligatorio, si el tipo lo tiene (carta: Anexo A)
  clause_text     text NOT NULL,    -- cláusula de aceptación electrónica
  -- Política de evidencia: qué se exige para dar el documento por firmado.
  otp_required              boolean NOT NULL DEFAULT true,
  photo_required            boolean NOT NULL DEFAULT false,
  photo_challenge_required  boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_type, version),
  UNIQUE (id, tenant_id, document_type),
  CHECK (NOT photo_challenge_required OR photo_required)
);
CREATE UNIQUE INDEX document_templates_one_active_idx
  ON document_templates (tenant_id, document_type) WHERE active;

CREATE TABLE signature_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  document_type      text NOT NULL,
  template_id        uuid NOT NULL,
  reference          text NOT NULL,
  external_ref       text NOT NULL,
  idempotency_key    text,
  status             request_status NOT NULL DEFAULT 'PENDING',
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
  -- La plantilla debe ser del mismo tenant y del mismo tipo que la solicitud.
  FOREIGN KEY (template_id, tenant_id, document_type)
    REFERENCES document_templates (id, tenant_id, document_type),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (delivery_mode = 'HOST' OR (delivery_channel IS NOT NULL AND delivery_to IS NOT NULL)),
  CHECK ((status = 'SIGNED') = (signed_at IS NOT NULL)),
  CHECK (status <> 'SIGNED' OR (pdf_path IS NOT NULL AND pdf_sha256 IS NOT NULL))
);
CREATE INDEX signature_requests_pending_expiry_idx ON signature_requests (expires_at) WHERE status = 'PENDING';

-- Desafío de la foto: código aleatorio que el cliente escribe en un papel y fotografía junto
-- al DNI. Un código emitido ahora no puede estar en una foto tomada antes de emitirse.
-- Pedir uno nuevo invalida el anterior (solo uno vivo por solicitud).
CREATE TABLE photo_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid NOT NULL REFERENCES signature_requests(id),
  code          char(4) NOT NULL CHECK (code ~ '^[0-9]{4}$'),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  superseded_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE UNIQUE INDEX photo_challenges_one_live_idx
  ON photo_challenges (request_id) WHERE consumed_at IS NULL AND superseded_at IS NULL;

CREATE TABLE signature_evidence (
  request_id          uuid PRIMARY KEY REFERENCES signature_requests(id),
  otp_verified_at    timestamptz,       -- NULL si la política del tipo no exige OTP
  otp_attempts       integer NOT NULL DEFAULT 0,
  challenge_id       uuid REFERENCES photo_challenges(id),
  photo_received_at  timestamptz,       -- hora del SERVIDOR; el EXIF lo controla el cliente
  photo_path         text,              -- se vacía al vencer la retención
  photo_sha256       char(64),          -- NULL si la política no exige foto
  photo_width        integer,
  photo_height       integer,
  form_json          jsonb,             -- lo que el firmante marcó/escribió (carta: facultades
                                        -- y observación), tal como lo vio
  CHECK ((photo_sha256 IS NULL) = (photo_received_at IS NULL)),
  clause_text        text NOT NULL,     -- texto exacto mostrado al cliente
  ip                 inet NOT NULL,
  user_agent         text NOT NULL,
  client_info        jsonb,
  captured_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid NOT NULL REFERENCES signature_requests(id),
  code_hash     char(64) NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE access_log (
  id          bigserial PRIMARY KEY,
  request_id   uuid REFERENCES signature_requests(id),
  event       text NOT NULL,            -- link_opened, otp_sent, otp_failed, signed, ...
  ip          inet,
  user_agent  text,
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid NOT NULL REFERENCES signature_requests(id),
  event         text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  next_try_at   timestamptz,
  delivered_at  timestamptz,
  last_status   integer
);

-- RLS: el rol de runtime solo ve las filas de su tenant (tablas con tenant_id).
-- Detalle de políticas se define en M1 junto con el rol de runtime.
