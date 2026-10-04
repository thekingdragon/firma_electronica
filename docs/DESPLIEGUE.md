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
```

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

Cada corredora envía desde **su** servidor de correo, nunca desde un dominio de la plataforma. La
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

## 7. Verificación después de instalar

- `GET https://<su-dominio>/v1/health` → `{"database":"up"}`.
- Abrir `https://<su-dominio>/` → pantalla de conexión del panel.
- Conectarse con la clave de API, crear una solicitud de prueba **a su propio correo**, abrir el enlace
  **desde un celular**, y comprobar: llega el código, se abre la cámara, se firma, llega la copia por
  correo y el panel muestra «Firmada».
- Si usa webhook: comprobar que su sistema recibe `signature.signed` y que la firma verifica.

## 8. Respaldos (sin esto, una falla del disco pierde las firmas)

El servidor es a la vez la única copia, igual que con Polix. Respaldar **las tres cosas juntas**:

1. La base `firma_electronica` (`pg_dump`).
2. La carpeta `STORAGE_DIR` (fotos y PDF **cifrados**).
3. `SECRETS_KEY`, **en otro lugar**: sin ella la carpeta del punto 2 no se puede leer.

Los respaldos de Polix **no** incluyen nada de esto.

## 9. Operación

- **Estado de los avisos al host:** tabla `webhook_deliveries` (`delivered_at`, `failed_at`, `last_error`).
- **Correo:** `tenant_mail_settings.last_error` guarda el último fallo de envío, ya explicado.
- **Solicitudes que no avanzan:** el vencimiento automático corre cada minuto; una solicitud vencida pasa
  a `EXPIRED` y avisa al host.
- **Retención de fotos:** cada 6 horas se borran los archivos de foto cuyo plazo (`retention_days` del
  tenant, 1825 días por defecto, contado desde la firma) venció. Se conservan los hash y la constancia.
  **El PDF firmado lleva la foto incrustada y no se toca**: si la retención debe alcanzar también esa
  copia, es una decisión legal pendiente.
- **Rotar `TOKEN_SECRET`:** invalida los enlaces de las solicitudes pendientes. Hágalo sin solicitudes
  vivas.
- **El servicio no tiene RLS entre tenants** (ver ARQUITECTURA §13). Con una sola corredora de confianza
  no es un riesgo práctico; antes de alojar corredoras que no se conozcan entre sí, hay que cerrarlo.

## 10. Exposición del panel

El panel es la misma página pública del dominio, y se entra con la **clave de API** del tenant (no hay
usuarios ni contraseñas todavía). La clave tiene 256 bits y los intentos fallidos se limitan por IP, así
que adivinarla no es viable; pero **quien la tenga controla el tenant** y queda guardada en el
navegador de quien la use. No la comparta ni la pegue en equipos que no sean de confianza.
