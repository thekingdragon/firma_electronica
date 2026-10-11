# Arquitectura

## 1. Principios

1. **Independiente del host.** Recibe un snapshot, no consulta la base del cliente. Cualquier
   sistema que sepa llamar una API REST y recibir un webhook puede usarlo.
2. **Genérico por tipo de documento.** El servicio firma «solicitudes» de un `document_type`
   (catálogo `document_types`). Cada tipo tiene su plantilla, su formulario y su **política de
   evidencia** por tenant. El primero es `APPOINTMENT_LETTER` (carta de nombramiento SBS); agregar
   otro es una fila de catálogo más una plantilla, no un rediseño.
3. **Multi-tenant y multipaís.** Plantilla, textos legales, logo, razón social e idioma son
   configuración del tenant. Nada de una práctica de mercado fijada en código.
4. **Evidencia sobre apariencia.** Una firma vale lo que valga su paquete de evidencia; el PDF es
   solo la cara visible.
5. **Canales intercambiables.** Email, SMS y WhatsApp son implementaciones de una misma interfaz;
   la verificación de identidad (fase 2) también (`IdentityVerifier`).

## 2. Pila

NestJS + PostgreSQL (SQL a mano, ver `apps/api/migrations/`), `pdf-lib` para el PDF, SPA React/Vite
(panel y página de firma) servida por la propia API. Archivos cifrados en disco (`STORAGE_DIR`).
**No usa Redis**: la cola de webhooks es una tabla (`webhook_deliveries`, patrón outbox) que un
trabajador interno recorre; el vencimiento y la retención son tareas periódicas del mismo proceso, con
candados de PostgreSQL para que dos instancias no hagan lo mismo. Un solo proceso, un solo puerto.

## 3. Flujo

```
Host ── POST /v1/requests (tipo, datos, contacto, delivery) ──▶ Servicio
Host ◀── { id, reference, signUrl? } ───────────────────────── Servicio
         (delivery=SERVICE: el servicio envía el link; delivery=HOST: el host lo envía)
Firmante abre signUrl ─▶ pide OTP ─▶ el servicio envía el OTP
Firmante ingresa OTP ─▶ ve el documento ─▶ completa el formulario del tipo
   ─▶ (si la política lo exige) código aleatorio + foto con la cámara ─▶ acepta
Servicio: genera PDF final, hash SHA-256, guarda evidencia
Servicio ── webhook signature.signed (aviso; el PDF y la foto se bajan con la clave de API) ──▶ Host
Corredor (panel o API): revisa la foto y el código ─▶ POST /v1/requests/:id/review
Servicio ── webhook signature.reviewed ──▶ Host
```

Otros avisos al host: `signature.revoked` y `signature.expired`. Contrato en [WEBHOOKS.md](WEBHOOKS.md).

## 4. Envío del link y del OTP

| Qué | Quién lo envía | Cómo se elige |
| --- | --- | --- |
| Link de firma | Servicio **o** host | `delivery: SERVICE \| HOST` al crear la solicitud |
| OTP | **Siempre el servicio** | `otp.channel: SMS \| WHATSAPP \| EMAIL` + `otp.to` |

Con `delivery=SERVICE` (solo `EMAIL`) el servicio envía el link desde el SMTP del tenant, en la misma
transacción que crea la solicitud: si el envío falla, **no queda creada** y el host puede reintentar con
la misma `Idempotency-Key`. Con `delivery=HOST` el host manda el link por el canal que ya use con el
cliente (p. ej. su WhatsApp; el panel arma un enlace `wa.me` con el mensaje escrito). El OTP sale por el servicio para que link y código no viajen juntos por el mismo
mensaje: si el host mandara ambos, quien intercepte el mensaje tendría los dos factores.
Recomendación: `otp.to` distinto del canal por el que se envió el link, cuando se pueda.
**Si link y OTP salen por el mismo buzón de correo, el OTP no aporta un segundo factor**: la
protección real pasa a ser la evidencia, no el factor. La API lo avisa (`warnings:
["LINK_AND_OTP_SAME_CHANNEL"]`) y el panel lo muestra.

**Correo:** SMTP **propio de cada tenant**, sin configurar por defecto y nunca desde un
dominio de la plataforma — misma regla que ya aplica Polix (la reputación de un dominio se
comparte: un solo tenant marcado como spam dejaría sin correo a todos). Se copia el patrón de
`transport.ts` y `secret-box.ts` de `gestor_segurov3`; no es una dependencia compartida.

**Costos y trabas [Probable]:** WhatsApp exige WhatsApp Business API con plantillas aprobadas por
Meta y proveedor de pago; SMS exige un agregador con cobertura Perú. Solo está implementado `EMAIL`;
`SMS` y `WHATSAPP` se rechazan con `CHANNEL_NOT_AVAILABLE` hasta definir proveedor (fase 2).

## 5. Estados de la solicitud

`PENDING → SIGNED` | `EXPIRED` | `REVOKED` (y `REJECTED`, reservado: nada lo produce hoy). Solo `PENDING`
puede cambiar; los demás son terminales. `EXPIRED` lo aplica una tarea que corre cada minuto al pasar
`expires_at` (además, un link vencido ya no abre por la fecha). `REVOKED` lo aplica el corredor desde la
API o el panel. Un documento firmado no se edita: si cambian los datos, se crea otra solicitud.

La **revisión de identidad** es aparte del estado: una firma sigue siendo `SIGNED` y lleva un dictamen
del corredor (`VERIFIED` / `REJECTED` / sin revisar), corregible, con su historial en la bitácora.

## 6. Paquete de evidencia y política por tipo

Qué se exige lo decide la plantilla del tipo (`otp_required`, `photo_required`,
`photo_challenge_required`). Lo que se captura, cuando aplica:

- OTP verificado: canal, destino enmascarado, fecha/hora, intentos.
- Foto capturada con la cámara (`getUserMedia`, sin selector de archivos), en la mayor resolución
  que dé el dispositivo, con su hash.
- **Desafío aleatorio de la foto:** el servidor emite un código de 4 dígitos (`photo_challenges`);
  el firmante lo escribe en un papel y se fotografía con el papel y su documento. Se guarda el
  código, la hora de emisión y la de recepción de la foto (ambas del servidor). La foto solo vale
  si el desafío sigue vivo al recibirla. Pedir un código nuevo invalida el anterior. Esto sostiene
  «en ese momento»: una foto previa o una cámara virtual con imagen preparada no puede contener un
  código que aún no existía. En fase 1 la comparación del código con la foto la hace una persona;
  el OCR, cuando se agregue, será una señal («código coincide» / «revisar») y **nunca un bloqueo**
  duro: con luz mala o dígitos manuscritos fallaría y dejaría sin firmar a clientes legítimos.
- Ventana del desafío: **10 minutos**, pensada para conexiones lentas de provincias; el firmante
  puede reintentar el envío con el mismo desafío mientras siga vivo.
- Lo marcado y escrito en el formulario del tipo (carta: facultades y «Observación»), tal como
  lo vio el firmante.
- IP, user agent, zona horaria del navegador, timestamp del servidor.
- Hash SHA-256 del PDF final y del snapshot original.
- Texto exacto de la cláusula de aceptación mostrada (versionada).

**La foto con documento NO es un requisito de la SBS** (ver §8): es una decisión de diseño que
añade datos sensibles (Ley 29733). Por eso es política por tipo y no obligatoria.

**Límite conocido [Seguro]:** no se puede impedir técnicamente una cámara virtual o un stream
manipulado. La barrera es de mejor esfuerzo; la defensa real es el conjunto de evidencia y, en
fase 1, la revisión humana del corredor (`SIGNED` = firmado por el firmante; el dictamen sobre la
identidad se registra con `POST /v1/requests/:id/review` o en el panel). Prueba de vida y comparación biométrica automática: fase 2, detrás de
`IdentityVerifier`; el servicio guardaría solo el veredicto, el id de verificación y los hashes,
no el biométrico.

### 6.1 Integridad: sello, sello de tiempo, bitácora y paquete

Qué hace el servicio para que la firma se pueda demostrar después, sin depender de que nadie «confíe»
en la base de datos:

- **PDF sellado.** Al firmar, el PDF se sella (firma digital desprendida CMS, estilo PAdES) con una llave
  propia del servicio; el sello cubre todo el archivo, así que cualquier cambio posterior lo invalida.
  La llave y su certificado (autofirmado, RSA 2048, 10 años) se generan solos; la llave privada se guarda
  cifrada con una subllave derivada de `SECRETS_KEY`. **El certificado es autofirmado: sella integridad, no
  identidad ni es firma digital con valor de certificado reconocido (INDECOPI/ECEP).** Su huella queda en
  `signature_requests.seal_cert_sha256`.
- **Sello de tiempo (RFC 3161).** Si hay `TSA_URL`, la huella del PDF sellado se envía a una autoridad
  de tiempo independiente y su respuesta (`.tsr`) se guarda cifrada. Es opcional y no bloquea la firma;
  se reintenta en segundo plano.
- **Bitácora encadenada e inalterable.** Cada evento de `access_log` lleva la huella del anterior
  (`prev_hash`, `hash`, SHA-256 calculado por la base), solo se agregan filas (UPDATE/DELETE y TRUNCATE
  rechazados por triggers) y `access_log_verify()` recorre la cadena. Las filas de evidencia y de
  solicitud ya firmadas solo permiten cambiar las columnas operativas (rutas de fotos, revisión, sello de
  tiempo); el resto queda congelado por trigger.
- **Verificación de punta a punta** (`checkIntegrity`): relee el PDF del disco, recalcula su huella,
  verifica el sello (y que cubra todo el archivo y sea el de la llave registrada), valida el sello de
  tiempo y recorre la cadena. La usan el panel (tarjeta «Integridad de la firma»), el paquete y el
  comando `evidence:verify`.
- **Paquete de evidencia** (`GET /v1/requests/:id/evidence-package`, botón del panel): ZIP con el PDF
  sellado, el certificado, el `.tsr`, `evidencia.json` (identidad registrada, bitácora y cadena), las fotos
  que sigan vigentes, `manifiesto.sha256` y un `LEEME.txt` con cómo verificarlo con herramientas
  estándar (p. ej. `openssl ts -verify`) sin este servicio.
- **Revisión que retiene la copia.** Con `reviewRequired` en la política de la plantilla, el firmante
  queda «firmado» pero su copia (correo y descarga) se retiene hasta que el personal marque la identidad
  como VERIFICADA; entonces se envía una sola vez. Viene apagado por defecto.

**Lo que esto NO es:** la firma sigue siendo **electrónica simple** con buena evidencia (Ley 27269, art.
1–3): vale como manifestación de voluntad, pero quien la impugne podrá exigir probar la identidad, y por
eso existen la revisión y el paquete. No equivale a firma digital con certificado de una ECEP.

### 6.2 Usuarios, sesiones y segundo factor del panel

Patrón tomado de `gestor_segurov3` (Polix), reescrito con `pg` plano: `users` (rol `OPERATOR`/`ADMIN`/`REVIEWER`, el
operador sin `tenant_id`, forzado por `CHECK`), `refresh_tokens` con familia y revocación con motivo, `mfa_recovery_codes`
y `password_resets` (migración 0011). Lo que se copió tal cual: el TOTP (`auth/totp.ts`, contrastado con los vectores de
los RFC). Lo que se conservó como decisión: el testigo intermedio del segundo factor usa **otra clave** que el access
token (si no, «contraseña correcta» valdría como sesión), cinco fallos del código cierran el factor 15 min, los códigos
de recuperación son de un uso y el restablecimiento no se salta el segundo factor.

- **Access token** JWT HS256 a mano (`auth/tokens.ts`), 15 min, con la **versión de sesión** del usuario: subirla (cambio
  de contraseña, baja, cambio de rol, quitar el factor) invalida al instante todos sus tokens. Es un contador y no una
  hora a propósito: comparar relojes de dos procesos falló en Windows (`Date.now()` va hasta ~15 ms por detrás).
- **Refresh** opaco, solo su hash en la base, cookie HttpOnly + SameSite=Strict en `/v1/auth`. Rota en cada renovación;
  un token ya reemplazado hace más de 20 s se presume robado y cae toda la familia. **Simplificación respecto a Polix:**
  no hay el endpoint de confirmación de recepción del token nuevo; la gracia de 20 s cubre dos pestañas, pero una
  respuesta que se pierda por más tiempo obliga a volver a entrar.
- **Guardas:** `ApiKeyGuard` acepta sesión (Bearer) **o** clave de API (integración, equivale a ADMIN de su corredora);
  `@Roles('ADMIN')` marca crear/revocar solicitudes, plantillas y ajustes; `AccessGuard` es solo sesión; `OperatorGuard`
  exige rol OPERATOR. Quien dictamina una identidad queda registrado con su nombre y correo de la sesión.
- **Fuera de alcance por ahora:** bitácora de inicios de sesión en base de datos (solo log del servicio), lista de
  dispositivos/sesiones activas, y los correos de aviso («iniciaron sesión desde…»).

## 7. Seguridad y datos personales

- Link con token de 256 bits derivado por HMAC del id (no se guarda: en base queda su hash); vence
  (por defecto 48 h, hasta 7 días). Cada abierto queda en la bitácora con IP y navegador.
- OTP de 6 dígitos guardado como HMAC (no el código), vigencia de 10 min, tope **atómico** de 5
  intentos (100 intentos en paralelo solo comparan 5), enfriamiento de 60 s y 5 envíos por hora.
- **Límite por IP** (ventana deslizante en memoria) en los endpoints públicos, con cupos menores para
  pedir el OTP, verificarlo y firmar; y límite a los intentos con clave de API inválida (responden
  429, pero una clave válida nunca se bloquea). Requiere `TRUST_PROXY` bien puesto.
- Tenant identificado por clave de API (guardada como hash). El aislamiento entre tenants es **por
  consulta** (cada una filtra por `tenant_id`; hay pruebas de aislamiento): **no hay RLS** (§13).
- Foto, PDF, contraseñas SMTP y secretos de webhook **cifrados en reposo** (AES-256-GCM, subclave por
  propósito derivada de `SECRETS_KEY`). Los archivos solo se sirven con la clave de API del tenant dueño
  o con la sesión del firmante; no hay URLs firmadas.
- Webhook firmado con HMAC-SHA256 (con timestamp, contra repetición), reintentos con espera creciente y
  protección contra SSRF validada **al conectar** (no solo al leer la URL).
- Retención por tenant: se borra el archivo de la foto al vencer el plazo y se conservan los hashes.
  El PDF firmado (que lleva la foto incrustada) no se toca (§13).
- Cabeceras: CSP estricta, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` (el token viaja en
  la URL de la página de firma), `Permissions-Policy` solo con cámara, `Cache-Control: no-store` en
  la API.
- HTTPS obligatorio (el túnel lo termina; sin HTTPS el navegador no ofrece la cámara). Mensajes de error
  al firmante en español, sin detalles técnicos.
- Cubrir el art. 27 de la Res. SBS 809-2019 (ver §8): confidencialidad, control de acceso y
  cambios no autorizados, copias de respaldo.

## 8. Marco legal (carta de nombramiento) y revisión pendiente

**Verificado leyendo el texto de la Res. SBS 809-2019** (copia alojada por Pacífico, no el diario
oficial; no se comprobó si fue modificada después de 2019):

- Art. 1, num. 9: «Firma» es la manifestación de voluntad; puede ser manuscrita o generada o
  comunicada por medios electrónicos, ópticos o análogos.
- Art. 32.6: la carta puede pactarse a distancia aplicando los arts. 27 y 28.
- Art. 27: el corredor responde por conservar la información y la aceptación del cliente, y por
  garantizar confidencialidad, integridad y disponibilidad (mínimo: acuerdos de confidencialidad,
  controles de acceso y cambios no autorizados, copias de respaldo).
- Art. 28: identificar al corredor y su código de registro; informar que debe firmarse la carta.
- Art. 32.1: la carta no faculta actos de disposición; los actos se hacen con coordinación y
  autorización previas. Arts. 32.4–32.5: el Anexo y el modelo se entregan al cliente. Art. 45:
  copia suscrita en el expediente del cliente.
- **No hay exigencia de foto del DNI** ni de un mecanismo de identidad concreto. El servicio la pide igual (segunda foto, `id_photo_required`, migración 0005; y el reverso, `id_photo_back_required`, migración 0007, porque el DNI se comprueba por ambas caras) para que la revisión humana pueda comparar el rostro con el documento; es una decisión de diseño, no un requisito de la SBS.

**Sin leer en texto primario:** Ley 27269 y DS 052-2008-PCM (según resúmenes, una firma generada
fuera de la infraestructura oficial vale según lo pactado entre las partes).

**Sigue pendiente de abogado (bloqueante para clientes reales)** — ya no es «¿la SBS lo acepta?»:

1. ¿Qué valor probatorio tiene OTP + (foto con desafío) + IP + hash ante una disputa?
2. Ley 29733: consentimiento expreso, plazo de retención, cifrado exigible y si hay que registrar
   el banco de datos ante la ANPD.

Entregable: opinión escrita + cláusula legal lista para la plantilla. Ajustará §6.

## 9. Plantilla de `APPOINTMENT_LETTER`

Deriva del modelo SBS (Anexo I y Anexo A). Puntos que la especificación original no cubría:

- La carta lista **los seguros nombrados** (A, B, C…), no números de póliza.
- Las **facultades** son casillas; el cliente puede restringirlas y escribir una observación. Se
  registran tal como las aceptó.
- El **Anexo A** (obligaciones del corredor, póliza de RC profesional, razón social y código de
  registro) lo pone el corredor: es `annex_text` de la plantilla, versionado.

### 9.1 Plantillas por bloques (editables desde el panel)

La plantilla de un documento es una **lista ordenada de bloques** que cada corredora arma y edita en el panel
(Plantillas): encabezado, título, subtítulo, párrafo, lista, lista de datos de la solicitud (los seguros),
facultades, datos del firmante, constancia de la firma, anexo y salto de página. Se guardan en
`document_templates.body_json.blocks` (jsonb); no hay tabla nueva.

- **Un solo sitio sabe qué bloques existen:** `apps/api/src/documents/blocks.ts` (tipos, validación,
  variables, lectura de plantillas anteriores). Lo usan el PDF (`render-blocks.ts`), la página de firma y el
  panel. El generador de PDF es el mismo para todos los tipos de documento; lo que cambia es la lista.
- **Todo es texto plano**, nunca HTML. Los textos admiten solo estas variables: `{{broker.legalName}}`,
  `{{broker.registryCode}}`, `{{signer.name}}`, `{{signer.documentType}}`, `{{signer.documentNumber}}`,
  `{{reference}}`, `{{date}}`. Cualquier otra se rechaza al publicar, con el bloque donde está.
- **Versionado inmutable:** publicar crea una versión nueva y la deja activa; una versión usada no se edita,
  y cada solicitud conserva la versión con la que nació. Queda quién publicó (`published_by`) y si se marcó
  como revisada.
- **Consentimientos:** el bloque `consent` es una casilla PROPIA (código, texto, obligatorio u opcional). Puede haber
  varios y cada uno se registra por separado en `form_json.consents` de la evidencia (los códigos marcados): no se
  mezcla «acepto firmar» con «autorizo el tratamiento de mis datos» ni con una publicidad opcional. Un obligatorio sin
  marcar impide firmar (el servidor lo vuelve a comprobar). El texto exacto que vio el firmante queda en el PDF y en
  la versión de plantilla fijada a la solicitud. La plantilla de partida trae el consentimiento de datos personales
  (Ley 29733) como borrador; las plantillas anteriores a los bloques NO lo reciben (no se les exige uno nuevo).
- **Aviso de datos personales al pie de los correos:** ajuste de la corredora (`tenants.privacy_notice`, texto plano,
  hasta 5000 caracteres, editable en el panel › Ajustes). `MailService.send` lo agrega a TODO correo del servicio
  (código, enlace de firma, copia firmada) en texto y, escapado, en HTML. Es informativo: lo que el firmante acepta y
  queda registrado es el bloque de consentimiento.
- **La constancia de la firma no es un bloque:** va siempre al final del PDF y ninguna plantilla puede quitarla.
- **En pantalla, la aceptación va siempre al final**, después de los anexos, sin importar dónde esté el bloque
  de constancia: no se puede aceptar sin haberlos tenido delante.
- **Plantillas anteriores** (textos sueltos + un anexo) se leen como los bloques equivalentes; no se migraron
  filas. La primera vez que se publica desde el panel se guardan por bloques. El comando `template:publish`
  se niega a cambiar el anexo suelto de una plantilla por bloques (diría que cambió y no cambiaría nada).
- **Quién escribe el texto responde por él:** el servicio valida la forma, no el contenido legal. El panel
  registra quién publicó y deja marcar «revisada por el área legal»; no bloquea la firma si no se marcó.

## 10. Integración con `gestor_segurov3` (pendiente: necesita su aprobación)

**No está hecha, y no se hizo a propósito:** toca el proyecto de producción y cambia la semántica de un
dato (`clients.appointment_letter_date`), y esas decisiones son del dueño de Polix.

Lo que haría falta, y que el servicio ya soporta sin cambios:

1. Un módulo pequeño en `apps/api` de Polix que cree la solicitud (`POST /v1/requests`) con un
   snapshot del cliente y guarde `externalRef` = el id del cliente.
2. Un receptor del webhook (`signature.signed`) que verifique la firma ([WEBHOOKS.md](WEBHOOKS.md)),
   baje el PDF con la clave de API, lo guarde vía `documents` y rellene `appointment_letter_date`.
   Decisión pendiente: ¿se rellena al firmar, o solo cuando el corredor marque `VERIFIED`?
3. Los avisos `signature.reviewed`, `signature.revoked` y `signature.expired` para reflejar el estado.

Por la regla de Polix sobre el front que depende de una API nueva, nada en `apps/web` de Polix hasta que
este servicio esté desplegado.

## 11. Decisiones abiertas

- Proveedor de SMS y de WhatsApp (costo, cobertura, plantillas).
- Plazo de retención de la foto (hoy 1825 días por tenant) **y si debe alcanzar también el PDF**, que la
  lleva incrustada: borrarla de ahí rompería su hash. Es una pregunta para el abogado.
- Si el servicio debe **negarse a crear solicitudes en producción mientras la plantilla activa siga en
  BORRADOR** (`legalReviewed: false`). Haría cumplir por código la regla «no usar con clientes reales
  sin revisión legal»; hoy es solo una advertencia en la documentación.
- Cuándo cerrar el aislamiento entre tenants con RLS (ver §13).
- Fase 2: modelo propio vs proveedor para prueba de vida y comparación facial; vía de acceso al RENIEC
  para un corredor (sin investigar).

## 12. Superficies y estructura del repo

Monorepo (`apps/*`), independiente de cualquier host, desplegado como **un solo proceso**:

1. **`apps/api`** — la API para hosts (`X-Api-Key`), los endpoints públicos de firma (`/v1/sign/*`:
   token + OTP + sesión), las tareas en segundo plano y los comandos de administración
   (`tenant:create`, `tenant:mail`, `tenant:webhook`, `template:publish`, `db:migrate`).
2. **`apps/web`** — React/Vite, compilado y servido por la API:
   - la **página pública de firma** (`/s/:token`),
   - el **panel** de la corredora: crear solicitudes (enlace por correo o copiar/WhatsApp), ver el
     estado, **revocar**, y por cada firma ver la foto, el código del desafío y lo registrado, descargar
     el PDF y registrar el **dictamen de identidad**.

El panel solo llama a la API pública, igual que lo haría un host; no toca la base. Si un día se quiere
separar, el límite ya está limpio.

## 13. Estado y deudas conocidas

**Hecho y probado** (pruebas automáticas de la API —unitarias y de integración contra PostgreSQL real y
un SMTP real— más un recorrido manual completo en el navegador montado como en producción):

- Alta de tenants, clave de API, SMTP propio, webhook y plantillas versionadas (todo por comando).
- Crear solicitud con idempotencia, validación por tipo y envío del link por el host o por el servicio.
- OTP por correo, página de firma con cámara en vivo **sin subir archivos** y código aleatorio para la
  foto; firma con evidencia completa, PDF y foto cifrados, copia por correo al firmante.
- Webhooks al host (outbox, firma HMAC, reintentos, SSRF), revocar, vencimiento automático, retención
  de fotos, revisión humana, límites por IP, cabeceras de seguridad y panel servido por la API.

**Deudas que NO están resueltas** (no dar la seguridad por cumplida hasta cerrarlas):

- **La cámara solo se probó con una cámara sintética** inyectada en el navegador de escritorio. Falta
  probar en celulares reales (sobre todo iOS/Safari y Android de gama baja) y con conexiones lentas:
  permisos, resolución real y los pisos de resolución (selfie recortada ≥ 540×640; documento recortado ≥ 600×1000), que pueden rechazar equipos antiguos.
- **El front no tiene pruebas automáticas**; solo se verificó a mano. La API sí está muy probada.
- **Revisión legal pendiente.** Las plantillas por defecto son BORRADOR (`legalReviewed: false` y la
  cláusula lo dice). Publicar el texto definitivo: `template:publish`. Nada impide hoy, por código, usar
  el servicio con el borrador (ver §11).
- **Sin RLS entre tenants.** El aislamiento depende de que cada consulta filtre por `tenant_id` (con
  pruebas de aislamiento en cada endpoint, pero un olvido en una consulta futura filtraría datos). Se
  dejó para después a propósito: exige separar el rol de la aplicación del dueño de la base y decidir
  cómo se fija el tenant en las rutas públicas (que llegan por token, sin tenant conocido). Con **una
  sola corredora de confianza** no es un riesgo práctico; antes de alojar corredoras que no se conozcan
  entre sí, hay que cerrarlo.
- **El PDF firmado conserva la foto**, aunque la retención borre el archivo de la foto (§11). Decisión
  vigente: el PDF y la evidencia no se borran por automatismo (ver DESPLIEGUE §9).
- **El sello es autofirmado** (§6.1): garantiza integridad y no identidad; no es una ECEP. El sello de
  tiempo de un tercero requiere `TSA_URL` y es opcional. Las firmas anteriores al sello se muestran como
  «anterior al sello de integridad».
- **Respaldo:** `npm run backup` copia base y archivos con manifiesto, pero **no** `SECRETS_KEY` ni lo
  lleva fuera de la máquina; eso es responsabilidad de quien opera (DESPLIEGUE §8).
- **El panel ya no entra con la clave de API** (§6.2): usuarios con rol, sesión corta con refresh en cookie HttpOnly y
  segundo factor. La clave de API del tenant queda solo para la integración del host. Pendiente: bitácora de inicios de
  sesión en la base y confirmación de recepción del refresh.
- **Los límites por IP son por proceso y en memoria** (se pierden al reiniciar; con varias instancias,
  cada una cuenta lo suyo). Dependen de `TRUST_PROXY`: mal puesto, todos los firmantes comparten un cupo.
- **Los webhooks fallidos no tienen pantalla**: tras ~23 h y 9 intentos se marcan `failed_at` en
  `webhook_deliveries` y nadie se entera salvo que mire la tabla. Tampoco hay alertas ni métricas.
- **El orden de los webhooks no está garantizado** y la entrega es «al menos una vez»: el receptor debe
  deduplicar por `X-Webhook-Id`.
- **El código de la foto lo compara una persona**: no hay OCR ni comparación del rostro con el documento
  (fase 2). Una cámara virtual puede mostrar lo que sea; la defensa es la revisión y la evidencia.
- **Fuera de alcance:** SMS y WhatsApp, otros tipos de documento (el servicio es genérico, pero solo
  existe la carta de nombramiento), y la integración con Polix (§10).
- Maquetación del PDF: la constancia queda en su propia página tras el anexo, con espacio en blanco, y
  las horas se muestran en UTC.
- El estado `REJECTED` de la solicitud existe en el modelo pero nada lo produce.

**Para producción (esta PC es el servidor):** ver [DESPLIEGUE.md](DESPLIEGUE.md).
