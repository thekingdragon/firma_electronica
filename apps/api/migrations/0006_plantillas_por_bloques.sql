-- Plantillas por bloques editables desde el panel.
-- Los bloques viven en body_json.blocks (jsonb): no hace falta otra tabla. Las plantillas anteriores, sin
-- bloques, se siguen leyendo como los bloques equivalentes (ver documents/blocks.ts), así que no se migran filas.
-- Una versión publicada no se edita nunca; esta columna deja constancia de quién la publicó.
ALTER TABLE document_templates ADD COLUMN published_by text;
