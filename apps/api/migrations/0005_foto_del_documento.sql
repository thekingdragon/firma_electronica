-- Segunda fotografía: la del documento de identidad, tomada en vivo (igual que la selfie, sin subir archivos).
-- Es una política más de la plantilla. Exige que la foto de verificación también lo sea: el documento
-- solo prueba algo junto a la selfie con el código.
ALTER TABLE document_templates
  ADD COLUMN id_photo_required boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT document_templates_id_photo_chk CHECK (NOT id_photo_required OR photo_required);

-- Las plantillas de carta de nombramiento que hoy están activas con foto pasan a pedirla.
UPDATE document_templates SET id_photo_required = true
 WHERE active AND photo_required AND document_type = 'APPOINTMENT_LETTER';

ALTER TABLE signature_evidence
  ADD COLUMN id_photo_received_at timestamptz,   -- hora del SERVIDOR
  ADD COLUMN id_photo_path        text,          -- se vacía al vencer la retención, igual que photo_path
  ADD COLUMN id_photo_sha256      char(64),
  ADD COLUMN id_photo_width       integer,
  ADD COLUMN id_photo_height      integer,
  ADD CONSTRAINT signature_evidence_id_photo_chk CHECK ((id_photo_sha256 IS NULL) = (id_photo_received_at IS NULL));
