-- Usuarios del panel (corredoras y operador de plataforma), sesiones, segundo factor y recuperación de contraseña.
-- Patrón tomado de gestor_segurov3 (Polix): refresh tokens con familia y detección de reuso, TOTP con códigos de
-- recuperación, cierre temporal tras fallos. La clave de API del tenant sigue existiendo, pero SOLO para integraciones
-- máquina a máquina (el host que crea solicitudes); el panel entra con usuario y contraseña.

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = operador de la plataforma (no pertenece a ninguna corredora).
  tenant_id             uuid REFERENCES tenants(id),
  email                 text NOT NULL,
  name                  text NOT NULL,
  password_hash         text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('OPERATOR', 'ADMIN', 'REVIEWER')),
  active                boolean NOT NULL DEFAULT true,
  -- Contraseña provisional (alta o restablecimiento hecho por otra persona): solo sirve para entrar a cambiarla.
  must_change_password  boolean NOT NULL DEFAULT false,
  failed_logins         integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  -- Segundo factor: la semilla va CIFRADA (SECRETS_KEY); mfa_enabled_at NULL = no activado.
  mfa_secret_enc        text,
  mfa_enabled_at        timestamptz,
  -- Último paso TOTP aceptado: impide reusar el mismo código dentro de su ventana de 30 s.
  mfa_last_step         bigint,
  -- Fallos seguidos del código y cierre temporal (solo se puede fallar el código habiendo pasado la contraseña).
  mfa_failed            integer NOT NULL DEFAULT 0,
  mfa_locked_until      timestamptz,
  -- Cada access token lleva la versión vigente al emitirse. Cambiar la contraseña, dar de baja o cerrar todas las sesiones la
  -- incrementa y los tokens anteriores dejan de valer. Es un contador, no una hora: no depende de que dos relojes coincidan.
  session_version       integer NOT NULL DEFAULT 0,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'OPERATOR') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX users_email_unq ON users (lower(email));
CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Solo el hash: quien lea la base no puede usar los tokens.
  token_hash     text NOT NULL UNIQUE,
  -- Todos los tokens que descienden de un mismo inicio de sesión; un reuso cierra la familia entera.
  family_id      uuid NOT NULL,
  created_ip     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  -- 'rotated' (reemplazado por el siguiente), 'logout', 'reuse' (robo presumido), 'password' (cambio de contraseña).
  revoked_reason text CHECK (revoked_reason IN ('rotated', 'logout', 'reuse', 'password')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE mfa_recovery_codes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);
