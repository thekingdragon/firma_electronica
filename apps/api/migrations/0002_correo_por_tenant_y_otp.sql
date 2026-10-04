-- 0002: correo propio por tenant y ajustes de otp_challenges.
--
-- Correo: cada tenant envía desde SU servidor SMTP, nunca desde un dominio de la plataforma (la
-- reputación de un dominio se comparte: un tenant marcado como spam dejaría sin correo a todos).
-- No haber fila para el tenant = no puede enviar; no hay modo «de la plataforma».
CREATE TABLE tenant_mail_settings (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id),
  host            text NOT NULL,
  port            integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  secure          boolean,                 -- NULL = deducir del puerto (465 = TLS directo)
  username        text,
  password_enc    text,                    -- AES-256-GCM (ver common/secret-box.ts); nunca en claro
  from_name       text,
  from_email      text NOT NULL,
  reply_to        text,
  verified_at     timestamptz,             -- última prueba de envío exitosa hecha a propósito
  last_ok_at      timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((username IS NULL) = (password_enc IS NULL))
);

-- OTP: `sent_at` se llena SOLO cuando el correo salió. El enfriamiento y el tope por hora cuentan
-- envíos reales, no intentos fallidos por un SMTP caído (que no deben dejar al firmante bloqueado).
-- `superseded_at` marca los códigos reemplazados por uno nuevo: solo vale el último.
ALTER TABLE otp_challenges
  ADD COLUMN sent_at       timestamptz,
  ADD COLUMN superseded_at timestamptz,
  ADD CONSTRAINT otp_challenges_attempts_chk CHECK (attempts >= 0);

CREATE INDEX otp_challenges_request_sent_idx ON otp_challenges (request_id, sent_at DESC);
