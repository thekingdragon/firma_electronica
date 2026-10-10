-- Registro a prueba de alteraciones.
--
-- 1) La bitácora (access_log) pasa a ser de SOLO ANEXAR y cada fila lleva una huella encadenada con la anterior de su
--    solicitud: cambiar, borrar o intercalar una fila rompe la cadena y se detecta con access_log_verify().
-- 2) La evidencia de una firma y la solicitud ya firmada no se pueden editar (salvo lo que la operación normal sigue
--    escribiendo: la revisión humana, el borrado de fotos vencidas y el sello de tiempo).
--
-- Honestidad sobre el alcance: quien sea dueño de la base de datos puede quitar estos disparadores. Lo que protege de
-- verdad frente a terceros es el PDF sellado y el sello de tiempo (migración 0010); esto impide los cambios por error o
-- desde la aplicación, y deja rastro verificable de los que se hagan por otra vía.

ALTER TABLE access_log ADD COLUMN prev_hash char(64), ADD COLUMN hash char(64);

-- Huella de una fila: sha256 de sus campos y de la huella anterior, con la hora en UTC y una forma fija.
CREATE FUNCTION access_log_row_hash(prev text, req uuid, ev text, at_ timestamptz, ip_ inet, ua text, det jsonb)
RETURNS char(64) LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    coalesce(prev, '') || '|' || coalesce(req::text, '') || '|' || ev || '|' ||
    to_char(at_ AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
    coalesce(host(ip_), '') || '|' || coalesce(ua, '') || '|' || coalesce(det::text, ''),
    'UTF8')), 'hex')
$$;

-- Las filas que ya existen se encadenan en orden (por solicitud y por id).
DO $$
DECLARE r record; prev text; cur uuid := NULL;
BEGIN
  FOR r IN SELECT id, request_id, event, at, ip, user_agent, detail FROM access_log ORDER BY request_id NULLS FIRST, id LOOP
    IF cur IS DISTINCT FROM r.request_id THEN prev := NULL; cur := r.request_id; END IF;
    UPDATE access_log SET prev_hash = prev,
      hash = access_log_row_hash(prev, r.request_id, r.event, r.at, r.ip, r.user_agent, r.detail)
     WHERE id = r.id;
    SELECT hash INTO prev FROM access_log WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE access_log ALTER COLUMN hash SET NOT NULL;

-- Cada fila nueva toma la huella de la anterior DE SU SOLICITUD. El candado evita que dos inserciones a la vez de la
-- misma solicitud tomen la misma «anterior» y bifurquen la cadena.
CREATE FUNCTION access_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('access_log:' || NEW.request_id::text, 0));
    SELECT hash INTO NEW.prev_hash FROM access_log WHERE request_id = NEW.request_id ORDER BY id DESC LIMIT 1;
  ELSE
    NEW.prev_hash := NULL;
  END IF;
  NEW.hash := access_log_row_hash(NEW.prev_hash, NEW.request_id, NEW.event, NEW.at, NEW.ip, NEW.user_agent, NEW.detail);
  RETURN NEW;
END $$;
CREATE TRIGGER access_log_chain_trg BEFORE INSERT ON access_log FOR EACH ROW EXECUTE FUNCTION access_log_chain();

CREATE FUNCTION access_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'access_log es de solo anexar: no se modifica ni se borra (fila %)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER access_log_append_only_trg BEFORE UPDATE OR DELETE ON access_log FOR EACH ROW EXECUTE FUNCTION access_log_append_only();

-- Comprueba la cadena de una solicitud. Devuelve la primera fila que no cuadra (o ninguna fila si todo está bien) y la
-- huella de la última, que es la que «resume» toda la bitácora hasta ese momento.
CREATE FUNCTION access_log_verify(p_request uuid)
RETURNS TABLE (ok boolean, broken_at bigint, head char(64), events integer) LANGUAGE plpgsql STABLE AS $$
DECLARE r record; prev text := NULL; n integer := 0;
BEGIN
  FOR r IN SELECT * FROM access_log WHERE request_id = p_request ORDER BY id LOOP
    n := n + 1;
    IF r.prev_hash IS DISTINCT FROM prev
       OR r.hash IS DISTINCT FROM access_log_row_hash(prev, r.request_id, r.event, r.at, r.ip, r.user_agent, r.detail) THEN
      RETURN QUERY SELECT false, r.id, r.hash, n;
      RETURN;
    END IF;
    prev := r.hash;
  END LOOP;
  RETURN QUERY SELECT true, NULL::bigint, prev::char(64), n;
END $$;

-- La evidencia de una firma no se edita. Lo único que la operación normal sigue escribiendo: la revisión humana, el
-- borrado de fotos vencidas (ruta y fecha de borrado) y nada más.
CREATE FUNCTION signature_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[] := ARRAY['photo_path', 'id_photo_path', 'id_back_path', 'photo_deleted_at',
                                'review_result', 'reviewed_by', 'review_note', 'reviewed_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'La evidencia de una firma no se borra (solicitud %)', OLD.request_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'La evidencia de una firma no se modifica (solicitud %)', OLD.request_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_evidence_guard_trg BEFORE UPDATE OR DELETE ON signature_evidence FOR EACH ROW EXECUTE FUNCTION signature_evidence_guard();

-- Una solicitud ya firmada no cambia: ni su contenido congelado, ni su PDF, ni su huella, ni su estado. Se permite
-- escribir el sello de tiempo (cuando llega, a veces después de firmar).
CREATE FUNCTION signature_requests_signed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[] := ARRAY['tsa_path', 'tsa_at', 'tsa_attempts'];
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'SIGNED' THEN
    RAISE EXCEPTION 'Una solicitud firmada no se borra (%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'SIGNED'
     AND (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'Una solicitud firmada no se modifica (%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER signature_requests_signed_guard_trg BEFORE UPDATE OR DELETE ON signature_requests FOR EACH ROW EXECUTE FUNCTION signature_requests_signed_guard();
