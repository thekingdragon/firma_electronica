-- Sello de integridad del PDF firmado y sello de tiempo de un tercero.
--
-- seal_keys: la llave con que el SERVICIO sella cada PDF (certificado autofirmado). La privada se guarda cifrada con
-- SECRETS_KEY. Hay una sola activa; rotarla es agregar otra y desactivar la anterior (los PDF viejos conservan la huella
-- del certificado con el que se sellaron, en seal_cert_sha256).
CREATE TABLE seal_keys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_pem     text NOT NULL,
  private_key_enc     text NOT NULL,
  fingerprint_sha256  char(64) NOT NULL UNIQUE,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX seal_keys_one_active_idx ON seal_keys ((true)) WHERE active;

ALTER TABLE signature_requests
  ADD COLUMN seal_cert_sha256 char(64),            -- certificado con el que se selló este PDF
  ADD COLUMN tsa_path         text,                -- sello de tiempo (respuesta RFC 3161), cifrado en disco
  ADD COLUMN tsa_at           timestamptz,         -- hora que certifica la autoridad de sellado
  ADD COLUMN tsa_attempts     integer NOT NULL DEFAULT 0;

-- Revisión de identidad que BLOQUEA: si la plantilla la exige, el firmante no recibe su copia ni puede descargarla
-- hasta que alguien de la corredora verifique su identidad.
ALTER TABLE document_templates ADD COLUMN review_required boolean NOT NULL DEFAULT false;
