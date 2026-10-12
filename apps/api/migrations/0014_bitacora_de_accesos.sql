-- Bitácora de ACCESOS y de administración de usuarios: quién entró, quién falló, quién cambió qué y desde dónde. Sirve para
-- investigar un acceso indebido y para poder demostrar quién hizo una acción de administración.
--
-- Solo se agrega: ningún UPDATE ni DELETE (trigger), igual que access_log. Sin claves foráneas a propósito: la bitácora no debe
-- depender de que el usuario o la corredora sigan existiendo, ni borrarse en cascada con ellos. El runtime de las corredoras
-- NO tiene permiso sobre esta tabla (como con users): solo el dueño la escribe y la lee.
CREATE TABLE auth_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  event       text NOT NULL,
  -- A quién le ocurrió. `email` queda tal como se escribió (también cuando la cuenta no existe: intentos contra correos ajenos).
  user_id     uuid,
  email       text,
  tenant_id   uuid,
  -- Quién lo hizo, cuando es otra persona (un administrador que restablece una contraseña, el operador que crea una corredora).
  actor_id    uuid,
  ip          text,
  user_agent  text,
  detail      jsonb
);
CREATE INDEX auth_events_tenant_idx ON auth_events (tenant_id, at DESC);
CREATE INDEX auth_events_user_idx   ON auth_events (user_id, at DESC);
CREATE INDEX auth_events_at_idx     ON auth_events (at DESC);

CREATE FUNCTION auth_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auth_events es solo de adición: no se modifica ni se borra' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER auth_events_append_only_trg BEFORE UPDATE OR DELETE ON auth_events
  FOR EACH ROW EXECUTE FUNCTION auth_events_append_only();
