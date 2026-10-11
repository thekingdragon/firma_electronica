-- Aislamiento entre corredoras con Row-Level Security (mismo patrón que gestor_segurov3):
--   · El DUEÑO de la base (DATABASE_URL) no está sujeto a RLS: migraciones, login, panel de operador y tareas en segundo plano.
--   · El RUNTIME de las corredoras corre con el rol `firma_runtime` (APP_DATABASE_URL), SIN BYPASSRLS, y cada conexión fija
--     `app.current_tenant`. Las políticas comparan contra current_tenant(); sin tenant fijado no se ve ninguna fila.
--   · Las tablas de usuarios y sesiones (users, refresh_tokens, mfa_recovery_codes, password_resets) NO se le conceden al
--     runtime: solo el dueño las toca.
--
-- ENABLE y no FORCE: el dueño de las tablas se salta las políticas a propósito.

CREATE FUNCTION current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid $$;

-- Tablas con tenant_id propio.
ALTER TABLE tenants              ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_requests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_mail_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants              USING (id = current_tenant())        WITH CHECK (id = current_tenant());
CREATE POLICY tenant_isolation ON document_templates   USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY tenant_isolation ON signature_requests   USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY tenant_isolation ON tenant_mail_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Tablas que cuelgan de una solicitud: pertenecen a la corredora dueña de esa solicitud.
ALTER TABLE signature_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_challenges   ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_challenges     ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signature_evidence
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()));
CREATE POLICY tenant_isolation ON photo_challenges
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()));
CREATE POLICY tenant_isolation ON otp_challenges
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()));
CREATE POLICY tenant_isolation ON webhook_deliveries
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()));
-- access_log.request_id admite NULL (eventos sin solicitud): esos no los ve ninguna corredora.
CREATE POLICY tenant_isolation ON access_log
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.tenant_id = current_tenant()));

-- Permisos del rol de runtime. LISTA BLANCA a propósito: una tabla nueva queda inaccesible hasta que se agregue aquí
-- (y se vuelva a ejecutar con `npm run db:grant`), en lugar de quedar abierta por olvido.
CREATE FUNCTION grant_runtime_access(runtime_role text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, UPDATE ON tenants TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON document_templates, signature_requests, signature_evidence, tenant_mail_settings TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON photo_challenges, otp_challenges, webhook_deliveries TO %I', runtime_role);
  -- Bitácora: solo se agrega y se lee (los triggers ya impiden UPDATE y DELETE; esto es una segunda barrera).
  EXECUTE format('GRANT SELECT, INSERT ON access_log TO %I', runtime_role);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE access_log_id_seq TO %I', runtime_role);
  -- Globales, sin RLS: tipos de documento (lectura) y la llave de sello (el runtime la lee y la crea la primera vez).
  EXECUTE format('GRANT SELECT ON document_types TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON seal_keys TO %I', runtime_role);
END $$;

-- Si el rol ya existe se le conceden ahora; si no, `npm run db:grant` lo hace después de crearlo.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firma_runtime') THEN
    PERFORM grant_runtime_access('firma_runtime');
  END IF;
END $$;
