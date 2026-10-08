-- Tercera fotografía: el REVERSO del documento de identidad (el DNI se verifica por ambas caras).
-- Es una política más de la plantilla y exige que la foto del anverso también lo sea.
ALTER TABLE document_templates
  ADD COLUMN id_photo_back_required boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT document_templates_id_photo_back_chk CHECK (NOT id_photo_back_required OR id_photo_required);

-- Las plantillas activas que ya piden el anverso pasan a pedir también el reverso.
UPDATE document_templates SET id_photo_back_required = true WHERE active AND id_photo_required;

ALTER TABLE signature_evidence
  ADD COLUMN id_back_received_at timestamptz,   -- hora del SERVIDOR
  ADD COLUMN id_back_path        text,          -- se vacía al vencer la retención, igual que las otras fotos
  ADD COLUMN id_back_sha256      char(64),
  ADD COLUMN id_back_width       integer,
  ADD COLUMN id_back_height      integer,
  ADD CONSTRAINT signature_evidence_id_back_chk CHECK ((id_back_sha256 IS NULL) = (id_back_received_at IS NULL));
