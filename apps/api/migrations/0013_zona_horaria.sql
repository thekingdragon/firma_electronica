-- Zona horaria de cada corredora (nombre IANA, p. ej. 'America/Lima'; nunca un desfase como '-05', que no sigue el horario
-- de verano). Todo lo guardado sigue siendo timestamptz (UTC); la zona solo decide CÓMO SE MUESTRA: en el PDF, en los
-- correos y en el panel, siempre con el desfase al lado ("04/10/2026 12:35 (UTC-5)"), igual que en Polix.
-- Lo que varía por país va configurable (la corredora puede estar en otra zona): el valor por defecto solo cubre a las ya creadas.
ALTER TABLE tenants
  ADD COLUMN timezone text NOT NULL DEFAULT 'America/Lima'
  CHECK (timezone ~ '^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$');

-- Mínimo privilegio: el runtime solo cambia dos columnas de su propia fila (antes podía actualizar cualquiera, incluida la
-- clave de API). Se redefine la función de permisos y se vuelve a ejecutar si el rol existe.
CREATE OR REPLACE FUNCTION grant_runtime_access(runtime_role text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
  EXECUTE format('REVOKE UPDATE ON tenants FROM %I', runtime_role);
  EXECUTE format('GRANT SELECT ON tenants TO %I', runtime_role);
  EXECUTE format('GRANT UPDATE (privacy_notice, timezone) ON tenants TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON document_templates, signature_requests, signature_evidence, tenant_mail_settings TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON photo_challenges, otp_challenges, webhook_deliveries TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON access_log TO %I', runtime_role);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE access_log_id_seq TO %I', runtime_role);
  EXECUTE format('GRANT SELECT ON document_types TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON seal_keys TO %I', runtime_role);
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firma_runtime') THEN
    PERFORM grant_runtime_access('firma_runtime');
  END IF;
END $$;
