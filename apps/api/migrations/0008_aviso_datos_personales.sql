-- Aviso sobre el uso de datos personales que cada corredora quiere al pie de los correos del servicio
-- (código de verificación, enlace de firma, copia firmada). Texto plano, editable desde el panel.
ALTER TABLE tenants
  ADD COLUMN privacy_notice text,
  ADD CONSTRAINT tenants_privacy_notice_len_chk CHECK (privacy_notice IS NULL OR char_length(privacy_notice) BETWEEN 1 AND 5000);
