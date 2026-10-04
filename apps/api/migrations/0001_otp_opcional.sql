-- 0001: el OTP es opcional por política del tipo de documento (document_templates.otp_required),
-- así que la solicitud puede no tener canal ni destino de OTP. Canal y destino van juntos o no van.
-- Que el OTP sea obligatorio cuando la plantilla lo exige lo valida la aplicación al crear la
-- solicitud (la regla cruza dos tablas).

ALTER TABLE signature_requests
  ALTER COLUMN otp_channel DROP NOT NULL,
  ALTER COLUMN otp_to DROP NOT NULL;

ALTER TABLE signature_requests
  ADD CONSTRAINT signature_requests_otp_pair_chk
  CHECK ((otp_channel IS NULL) = (otp_to IS NULL));
