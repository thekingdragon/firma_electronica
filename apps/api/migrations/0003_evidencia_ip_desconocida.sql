-- 0003: la IP de la evidencia puede ser desconocida.
--
-- Si no se puede determinar la dirección del firmante (proxy sin configurar, dirección no válida),
-- lo honesto es dejarla vacía. Inventar un valor (0.0.0.0) en una constancia de firma sería
-- evidencia falsa. La constancia y el PDF muestran «desconocida» cuando falta.
ALTER TABLE signature_evidence ALTER COLUMN ip DROP NOT NULL;
