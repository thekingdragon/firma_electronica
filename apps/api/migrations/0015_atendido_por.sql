-- Quién ATENDIÓ al cliente: la persona que creó la solicitud y envió el enlace (NO quien revisa la identidad, que se registra aparte
-- en la revisión). Es un texto guardado al crear (nombre de la persona que tenía la sesión, o el que mande la integración): si esa
-- persona cambia de nombre o se da de baja después, el documento firmado sigue diciendo quién atendió ese día.
ALTER TABLE signature_requests
  ADD COLUMN attended_by text CHECK (attended_by IS NULL OR length(attended_by) BETWEEN 1 AND 160);
