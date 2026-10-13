# Despliegue en producción

Pensado para la máquina donde hoy corre Polix (la misma PC es el servidor). Los comandos están en
**PowerShell** (como los de Polix). **Este documento solo
describe los pasos; no se ejecutó ninguno de ellos en el servidor.** PM2 corre como `LocalSystem` y
rechaza los comandos que no vengan de una consola de administrador, así que los pasos de «Instalar»
los hace una persona con ese acceso.

## Antes de nada: lo que bloquea usarlo con clientes reales

1. **Revisión legal** (ARQUITECTURA §8). Las plantillas nacen en **BORRADOR** y la cláusula lo dice.
   Cuando el abogado entregue el texto definitivo, se publica con `template:publish` (más abajo).
2. **Probar la cámara en celulares reales** (iOS/Safari y Android de gama baja). Solo se probó con una
   cámara sintética.
3. **HTTPS.** Sin él el navegador no ofrece la cámara.

## Qué corre

Un solo proceso Node (`firma-api`, puerto 4000, solo en `127.0.0.1`) que sirve:

- la **API** (`/v1/*`),
- el **panel** y la **página de firma** compilados (`apps/web/dist`), en la misma dirección,
- las tareas en segundo plano (entrega de webhooks, vencimiento, retención).

Necesita PostgreSQL. **No necesita Redis** (la cola de webhooks vive en la base).

## 1. Base de datos

En el mismo servidor PostgreSQL de Polix, pero **base y rol aparte** (no reutilice el rol `artificial`):

```sql
CREATE ROLE firma_app LOGIN PASSWORD '<clave larga y aleatoria>';
CREATE DATABASE firma_electronica OWNER firma_app;
-- Rol de RUNTIME (aislamiento entre corredoras, ver ARQUITECTURA §6.2): sin BYPASSRLS ni superusuario.
CREATE ROLE firma_runtime LOGIN PASSWORD '<otra clave larga y aleatoria>';
```

`firma_app` (el dueño, `DATABASE_URL`) hace las migraciones, el login, el panel de operador y las tareas en segundo
plano. **`firma_runtime` (`APP_DATABASE_URL`) es con el que corren las corredoras**, sujeto a Row-Level Security: solo
ve las filas de la corredora de cada petición y no toca las tablas de usuarios ni de sesiones. Tras migrar:

```
npm run db:migrate -w api
npm run db:grant -w api      # concede a firma_runtime solo lo que necesita (repetir si una migración agrega tablas)
```

Sin `APP_DATABASE_URL` la API corre con el dueño, **el aislamiento no está activo** y el arranque y el panel de operador
lo avisan (no se detiene, para no tumbar un despliegue existente).

## 2. Código y variables

```
cd "C:\Users\MavacTI\Desktop\WEB\WEB\GCM\firma-electronica-service"
npm ci
Copy-Item apps\api\.env.example apps\api\.env      # y completarlo (ver más abajo)
```

Variables mínimas de `apps/api/.env` (las demás tienen valor por defecto; ver `.env.example`):

| Variable | Valor |
| --- | --- |
| `DATABASE_URL` | `postgres://firma_app:<clave>@localhost:5432/firma_electronica` |
| `TOKEN_SECRET` | 48 bytes aleatorios (comando en `.env.example`). No cambiarlo con solicitudes vivas. |
| `SECRETS_KEY` | 32 bytes aleatorios. **Respaldarla aparte.** Si se pierde, lo cifrado es irrecuperable. |
| `PUBLIC_BASE_URL` | La dirección pública con `https`, sin barra final (p. ej. `https://firma.su-dominio.com`). |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` (el túnel de Cloudflare es un salto de proxy). **Sin esto todos los firmantes comparten una sola IP y un solo cupo.** |
| `STORAGE_DIR` | Una carpeta fuera del repo **con respaldo** (guarda fotos y PDF cifrados). |
| `WEB_DIST_DIR` | `../web/dist` |

`ALLOW_DEV_OTP` y `WEBHOOK_ALLOW_PRIVATE` deben quedar en `false`: el arranque se niega a combinarlos
con `NODE_ENV=production`.

## 3. Compilar y migrar

```
npm run build:all
npm run db:migrate
```

`db:migrate` aplica `apps/api/migrations/*.sql` en orden y es seguro repetirlo. No usa el generador de
Drizzle: las migraciones se escriben a mano.

## 4. Primer tenant (la corredora)

```
npm run tenant:create -w api -- --name "Mi Corredora" --country PE --legal-name "Mi Corredora de Seguros S.A.C." --registry "J-0000"
```

Imprime la **clave de API** y el **secreto de webhook** una sola vez. Guárdelos: no se pueden recuperar
(en la base solo queda un hash de la clave y el secreto cifrado).

### Correo (SMTP propio de la corredora)

**Lo normal es configurarlo desde el panel:** el administrador entra a **Ajustes → Correo de la corredora**, elige su proveedor (Gmail,
Microsoft 365 u otro), escribe usuario y contraseña y pulsa **Enviar correo de prueba**. La contraseña se guarda cifrada y no se vuelve a
mostrar; el panel indica si el correo quedó **verificado**. Con Gmail hace falta una «contraseña de aplicación» (no la normal) y con Microsoft 365
que el administrador del correo habilite «SMTP autenticado». El servidor de correo no puede apuntar a una dirección interna o privada.

Cada corredora envía desde **su** servidor de correo, nunca desde un dominio de la plataforma. Por línea de comandos (alternativa) la
contraseña va por variable de entorno para que no quede en el historial de la consola:

```
$env:SMTP_PASSWORD = '<contraseña>'
npm run tenant:mail -w api -- --tenant <uuid> --host smtp.su-proveedor.com --port 587 --user avisos@corredora.com --from-email avisos@corredora.com --from-name "Mi Corredora" --test-to su-correo@corredora.com
Remove-Item Env:SMTP_PASSWORD
```

Con `--test-to` envía un correo de prueba y, si sale, deja el correo marcado como verificado. Sin correo
configurado el firmante no recibe el código y **no puede firmar** (`MAIL_NOT_CONFIGURED`).

### Webhook (opcional, para sistemas que quieran recibir avisos)

```
npm run tenant:webhook -w api -- --tenant <uuid> --url https://su-sistema.com/hooks/firma --rotate
```

Contrato y verificación de la firma: [WEBHOOKS.md](WEBHOOKS.md).

### Plantilla definitiva (tras la revisión legal)

Guardar la cláusula revisada en un archivo UTF-8 y publicarla:

```
npm run template:publish -w api -- --tenant <uuid> --clause-file clausula.txt --legal-reviewed true
```

Crea una **versión nueva** y la deja activa. Las solicitudes ya creadas siguen con la versión con la que
se crearon. También sirve para el anexo (`--annex-file`) y para la política de evidencia (`--photo`,
`--photo-challenge`, `--otp`).

## 5. Instalar el proceso (administrador)

```
pm2 start ecosystem.config.js
pm2 save
```

Es el mismo mecanismo que `gestor-api`: sin modo watch. Para actualizar:

```
npm ci
npm run build:all
npm run db:migrate
pm2 restart firma-api
```

(Antes, traer el código nuevo: `git pull` o copiar los cambios.)

## 6. Dirección pública (túnel de Cloudflare)

Agregar al túnel existente una entrada que lleve el nombre elegido a `http://127.0.0.1:4000` (p. ej.
`firma.su-dominio.com` → `http://127.0.0.1:4000`), y crear el registro DNS de ese nombre hacia el túnel.
Cómo se hace depende de cómo esté configurado el túnel de Polix (por archivo de configuración o desde el
panel de Cloudflare); **no se revisó en este equipo**. **El servicio no abre ningún puerto al exterior**:
solo escucha en `127.0.0.1`.

## 7. Verificación antes de abrir al público y después de instalar

**Antes de dar el servicio por listo, ejecute la verificación previa.** Revisa de una vez la configuración, la base y los datos, dice qué
falta y cómo arreglarlo, y sale con error si hay algo que impide producción:

```
npm run preflight -w api
```

Comprueba, entre otras cosas: `NODE_ENV=production`, `ALLOW_DEV_OTP` apagado, dirección pública definitiva con https (no un túnel provisional),
`SECRETS_KEY`, sello de tiempo, migraciones al día, aislamiento entre corredoras activo, un operador con segundo factor, que no queden usuarios de
prueba, que cada corredora tenga **correo verificado** y un administrador, que las plantillas tengan revisión legal y que exista un respaldo
reciente. **No imprime secretos.** Al final recuerda lo que ninguna comprobación automática puede asegurar (respaldos fuera de la máquina,
`SECRETS_KEY` guardada aparte, aprobación del abogado, cámara probada en celulares reales: ver `PRUEBA-CAMARA.md`).

Para el personal que revisa identidades hay una guía lista para entregar: `GUIA-REVISION.md`.

Después de instalar:

- `GET https://<su-dominio>/v1/health` → `{"database":"up"}`.
- Abrir `https://<su-dominio>/` → pantalla de conexión del panel.
- Conectarse con la clave de API, crear una solicitud de prueba **a su propio correo**, abrir el enlace
  **desde un celular**, y comprobar: llega el código, se abre la cámara, se firma, llega la copia por
  correo y el panel muestra «Firmada».
- Si usa webhook: comprobar que su sistema recibe `signature.signed` y que la firma verifica.

## 8. Respaldos (sin esto, una falla del disco pierde las firmas)

El servidor es a la vez la única copia, igual que con Polix. Respaldar **las tres cosas juntas**:

1. La base `firma_electronica` (`pg_dump`).
2. La carpeta `STORAGE_DIR` (fotos, PDF sellados y sellos de tiempo, **cifrados**).
3. `SECRETS_KEY`, **en otro lugar**: sin ella la carpeta del punto 2 no se puede leer **ni la llave con
   que se sellan los PDF** (está en la base, cifrada con esta clave).

Los respaldos de Polix **no** incluyen nada de esto.

**Comando.** Hace los puntos 1 y 2 y deja un manifiesto con la huella de cada archivo; conserva los 14 más
nuevos (`--keep 0` no borra ninguno):

```
npm run backup -w api -- --out D:\respaldos\firma --keep 14
npm run backup -w api -- --verify D:\respaldos\firma\<AAAAMMDD-HHMMSS>
```

El comando **no** copia `SECRETS_KEY` (a propósito: quien tuviera el respaldo tendría también la clave).
Programe el primero cada noche y copie la carpeta de respaldos **fuera de esta máquina**: un respaldo en el
mismo disco no protege de una falla del disco. Pruebe restaurar en otra máquina (`pg_restore` + copiar la
carpeta `storage` a `STORAGE_DIR` + la misma `SECRETS_KEY`) y ejecute `evidence:verify` al terminar: si
todo cuadra, el respaldo sirve.

**Comprobar las firmas** (PDF intacto, sello válido, sello de tiempo y bitácora sin alterar), a mano o
programado tras cada respaldo; sale con código 1 si alguna falla:

```
npm run evidence:verify -w api -- [--tenant <uuid>] [--since 2026-01-01] [--strict]
```

Las firmas anteriores al sello de integridad se cuentan aparte («anteriores al sello»); con `--strict` se
tratan como fallo.

## 9. Operación

- **Usuarios y acceso al panel.** El panel entra con **correo y contraseña** (no con la clave de API). Roles:
  `ADMIN` (todo en su corredora, incluido gestionar personas), `REVIEWER` (consulta y dictamina la identidad; no crea
  solicitudes ni toca plantillas o ajustes) y `OPERATOR` (administra la plataforma, sin corredora propia). La clave de
  API de la corredora queda **solo para la integración del host** (crear solicitudes máquina a máquina) y no gestiona
  personas. Sesión: access token de 15 min en memoria + cookie de refresh HttpOnly de 7 días que se rota; reusar un
  refresh ya reemplazado cierra la sesión entera. Cambiar la contraseña, dar de baja o cambiar el rol cortan las
  sesiones al instante. Segundo factor (TOTP, con 10 códigos de recuperación): opcional, **obligatorio para el
  operador**. Cuentas: 10 fallos de contraseña la cierran 5 min; 5 fallos del código, 15 min. Recuperación por correo
  (enlace de un uso, 60 min) sale por el SMTP de la corredora; **el operador no tiene correo desde el cual recibirlo**.
- **Crear el primer operador** (en esta máquina; la contraseña provisional se imprime una vez y debe cambiarse, y el
  segundo factor se activa al entrar):

```
npm run operator:create -w api -- --email ana@empresa.com --name "Ana Pérez"
npm run operator:reset  -w api -- --email ana@empresa.com [--mfa]   (perdió la contraseña, o el teléfono con --mfa)
```

- **Panel de operador** (`/operador`): lo usa quien administra el servicio entero, no una corredora. Muestra el
  estado (base, carpeta de archivos, `SECRETS_KEY`, llave de sello, sello de tiempo), los totales de todas las
  corredoras, sus alertas (correo con error, webhooks fallidos, sellos de tiempo pendientes, firmas por revisar),
  permite **dar de alta** una corredora con su primer administrador (clave de API y contraseña provisional se muestran
  una sola vez), **agregar un administrador** a una que se quedó sin acceso, **activar/desactivar** una (desactivada,
  sus usuarios y su clave dejan de funcionar) y **verificar sus últimas 100 firmas**. **Por defecto no se abre por el
  túnel de Cloudflare** (ni el login del operador): solo desde esta máquina o la red local;
  `OPERATOR_ALLOW_REMOTE=true` lo abre a Internet. Las altas y desactivaciones quedan en el log del servicio, no en una
  bitácora de base de datos.
- **Rotar `TOKEN_SECRET` también cierra todas las sesiones** del panel (firma los access token), además de invalidar
  los enlaces pendientes.

- **Estado de los avisos al host:** tabla `webhook_deliveries` (`delivered_at`, `failed_at`, `last_error`).
- **Correo:** `tenant_mail_settings.last_error` guarda el último fallo de envío, ya explicado.
- **Solicitudes que no avanzan:** el vencimiento automático corre cada minuto; una solicitud vencida pasa
  a `EXPIRED` y avisa al host.
- **Retención de fotos:** cada 6 horas se borran los archivos de foto cuyo plazo (`retention_days` del
  tenant, 1825 días por defecto, contado desde la firma) venció. Se conservan los hash y la constancia.
  **El PDF firmado y su evidencia (bitácora, huellas, sello de tiempo) NO se borran nunca por
  automatismo**: son la prueba de la firma y el PDF lleva la foto incrustada. Decisión vigente: se conservan
  mientras el tenant no pida lo contrario; si la retención debe alcanzar también esa copia, es una decisión
  legal pendiente y debe ser un borrado explícito, no un trabajo programado.
- **Revisión legal obligatoria (`REQUIRE_LEGAL_REVIEW=true`):** con ella encendida no se crean solicitudes con una plantilla
  que no esté marcada como revisada (409 `TEMPLATE_NOT_REVIEWED`). Está **apagada por defecto** para no detener un
  despliegue existente; enciéndala cuando el abogado haya aprobado el texto y se haya publicado con `legalReviewed`. El panel
  de operador muestra si está activa.
- **Cancelación de datos de un titular (Ley 29733):** un administrador puede **eliminar las fotos** de una firma antes de que
  venza la retención (botón en la evidencia, `POST /v1/requests/:id/purge-photos`), indicando el motivo; queda en la bitácora
  con su nombre. **No borra el PDF firmado** (lleva las fotos incrustadas y alterarlo rompe su sello): si el titular pide
  también eso, es una decisión legal aparte.
- **Bitácora de accesos** (`auth_events`): inicios de sesión y fallidos, segundo factor, cambios de contraseña y altas, bajas o
  cambios de rol de usuarios, y las acciones del operador (crear o desactivar corredoras, agregar administradores), con IP y
  navegador. Solo se agrega (trigger) y el runtime de las corredoras no puede ni leerla. El administrador ve la de su corredora
  (Usuarios) y el operador la de todas. Nunca guarda contraseñas ni códigos.
- **Sello de tiempo de un tercero:** defina `TSA_URL` (p. ej. `http://timestamp.digicert.com`, gratuita).
  Sin ella la firma funciona, pero su fecha es solo la del servidor. Si la autoridad no responde, la firma
  **no se bloquea**: el sello se reintenta en segundo plano (hasta 12 veces, con esperas crecientes) y el
  panel muestra «pendiente».
- **La llave de sello** se crea sola con la primera firma y se guarda cifrada con `SECRETS_KEY`. Si
  `SECRETS_KEY` cambia, el servicio **se niega a firmar** (error `SEAL_NOT_AVAILABLE`, 503) en vez de crear
  otra llave en silencio: restaure la clave correcta.
- **Rotar `TOKEN_SECRET`:** invalida los enlaces de las solicitudes pendientes. Hágalo sin solicitudes
  vivas.
- **Aislamiento entre corredoras (RLS):** activo si `APP_DATABASE_URL` usa el rol `firma_runtime` (ver §1). El panel
  de operador muestra si lo está. Una tabla nueva queda **inaccesible** para el runtime hasta agregarla a
  `grant_runtime_access` (lista blanca) y correr `db:grant`: falla cerrado, no abierto.

## 10. Exposición del panel

El panel es la misma página pública del dominio, y se entra con la **clave de API** del tenant (no hay
usuarios ni contraseñas todavía). La clave tiene 256 bits y los intentos fallidos se limitan por IP, así
que adivinarla no es viable; pero **quien la tenga controla el tenant** y queda guardada en el
navegador de quien la use. No la comparta ni la pegue en equipos que no sean de confianza.
