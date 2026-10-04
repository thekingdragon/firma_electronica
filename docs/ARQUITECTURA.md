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

NestJS + PostgreSQL (SQL a mano, ver `apps/api/migrations/`), `pdf-lib` para el PDF, SPA mínima
React/Vite para la página de firma servida por el propio servicio. Almacenamiento con proveedor
intercambiable (disco local o S3). Cola (BullMQ + Redis) para webhooks con reintento y para
expirar solicitudes.

## 3. Flujo

```
Host ── POST /v1/requests (tipo, datos, contacto, delivery) ──▶ Servicio
Host ◀── { id, reference, signUrl? } ───────────────────────── Servicio
         (delivery=SERVICE: el servicio envía el link; delivery=HOST: el host lo envía)
Firmante abre signUrl ─▶ pide OTP ─▶ el servicio envía el OTP
Firmante ingresa OTP ─▶ ve el documento ─▶ completa el formulario del tipo
   ─▶ (si la política lo exige) código aleatorio + foto con la cámara ─▶ acepta
Servicio: genera PDF final, hash SHA-256, guarda evidencia
Servicio ── webhook signature.signed (PDF + evidencia) ──▶ Host
```

## 4. Envío del link y del OTP

| Qué | Quién lo envía | Cómo se elige |
| --- | --- | --- |
| Link de firma | Servicio **o** host | `delivery: SERVICE \| HOST` al crear la solicitud |
| OTP | **Siempre el servicio** | `otp.channel: SMS \| WHATSAPP \| EMAIL` + `otp.to` |

Con `delivery=HOST` el host manda el link por el canal que ya use con el cliente (p. ej. su
WhatsApp). El OTP sale por el servicio para que link y código no viajen juntos por el mismo
mensaje: si el host mandara ambos, quien intercepte el mensaje tendría los dos factores.
Recomendación: `otp.to` distinto del canal por el que se envió el link, cuando se pueda.
**Si link y OTP salen por el mismo buzón de correo, el OTP no aporta un segundo factor**: la
protección real pasa a ser la evidencia, no el factor.

**Correo (M1):** SMTP **propio de cada tenant**, estado `disabled` por defecto y nunca desde un
dominio de la plataforma — misma regla que ya aplica Polix (la reputación de un dominio se
comparte: un solo tenant marcado como spam dejaría sin correo a todos). Se copia el patrón de
`transport.ts` y `secret-box.ts` de `gestor_segurov3`; no es una dependencia compartida.

**Costos y trabas [Probable]:** WhatsApp exige WhatsApp Business API con plantillas aprobadas por
Meta y proveedor de pago; SMS exige un agregador con cobertura Perú. En M1 solo se implementa
`EMAIL`; `SMS` y `WHATSAPP` quedan como interfaces con proveedor por definir (decisión pendiente).

## 5. Estados de la solicitud

`PENDING → SIGNED` | `REJECTED` | `EXPIRED` | `REVOKED`. Solo `PENDING` puede cambiar; los demás
son terminales. `EXPIRED` lo aplica un job al pasar `expires_at`. Un documento firmado no se
edita: si cambian los datos, se crea otra solicitud.

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
fase 1, la revisión humana del corredor (`SIGNED` = firmado por el firmante; la verificación
visual la registra el host). Prueba de vida y comparación biométrica automática: fase 2, detrás de
`IdentityVerifier`; el servicio guardaría solo el veredicto, el id de verificación y los hashes,
no el biométrico.

## 7. Seguridad y datos personales

- Link con token aleatorio de un solo uso, guardado solo como hash; expira (24–48 h).
- OTP de 6 dígitos con vencimiento corto y tope de intentos; bloqueo por solicitud y por IP.
- Tenant aislado por clave de API (guardada como hash); RLS por `tenant_id`.
- Foto y PDF **cifrados en reposo**; acceso solo por URLs firmadas de corta vida.
- Webhook firmado con HMAC-SHA256 y reintentos con backoff.
- Retención configurable por tenant; borrado de foto al vencer el plazo, conservando hashes.
- HTTPS obligatorio. Mensajes de error al firmante en español.
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
- **No hay exigencia de foto del DNI** ni de un mecanismo de identidad concreto.

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

## 10. Integración con `gestor_segurov3`

Módulo pequeño en su API: crea la solicitud con un snapshot del cliente; al recibir el webhook
guarda el PDF vía `documents` y rellena `clients.appointment_letter_date`. Eso se hace en M3 y,
por la regla de «front que depende de API nueva», no se toca `apps/web` hasta que el servicio esté
desplegado.

## 11. Decisiones abiertas

- Proveedor de SMS y de WhatsApp (costo, cobertura, plantillas).
- Dónde se aloja (misma PC con otro proceso PM2 y otra ruta de túnel, o aparte).
- Plazo de retención de la foto.
- Fase 2: modelo propio vs proveedor para prueba de vida y comparación facial; vía de acceso al
  RENIEC para un corredor (sin investigar).

## 12. Superficies y estructura del repo

Monorepo (`apps/*`), independiente de cualquier host:

1. **`apps/api`** — API para hosts (`X-Api-Key`). Es lo único de M1.
2. **`apps/web`** — el **panel propio** (primera versión hecha) y, a continuación, la **página
   pública de firma**. El panel para quien use el servicio sin un sistema detrás: login, listar y crear solicitudes,
   enviar el link (correo, o enlace `wa.me` con el mensaje prellenado para WhatsApp, sin proveedor
   de pago), revocar, descargar PDF y **revisar la foto** (la revisión humana de la fase 1 necesita
   dónde vivir cuando no hay host).

Decisión: el panel vive en este repo y **solo llama a la capa de servicios de la API**, nunca a la
base por su cuenta. Así la API y el panel comparten una sola lógica y, si un día se quiere separar
el panel, el límite ya está limpio. El panel no se construye antes de que exista la página de
firma: sin ella no tiene nada que enviar. Gestión de usuarios y roles avanzados, después.

## 13. Estado y deudas conocidas

**Hecho y probado (suite automática + recorrido real en el navegador):**

- Tenants con clave de API (hash SHA-256 en base; se muestra una sola vez). Plantilla de partida por
  tenant con las facultades del art. 32.1 y el Anexo A.
- `POST /v1/requests` con validación por tipo, idempotencia, rechazo de UTF-8 inválido y link de firma
  derivado por HMAC (`TOKEN_SECRET`).
- **OTP por correo**: SMTP propio de cada tenant (contraseña cifrada), código de 6 dígitos guardado como
  HMAC, vigencia de 10 min, tope atómico de 5 intentos, enfriamiento de 60 s, 5 envíos por hora.
- **Página pública de firma** (`/s/:token`): verificación, lectura de la carta con sus facultades
  editables, cámara en vivo **sin opción de subir archivo**, código aleatorio de 4 dígitos para la foto
  (10 min), revisión y firma. Recupera la sesión al recargar.
- **Firma**: foto validada por sus bytes (JPEG/PNG, mínimo 1280×720, máx. 8 MB), PDF generado con la
  constancia, foto y PDF **cifrados en disco** (AES-256-GCM), evidencia completa en base, estado
  `SIGNED` en una transacción con la solicitud bloqueada (no se firma dos veces), copia por correo
  al firmante cuando hay SMTP, y descargas para el host con su clave de API.
- Panel (`apps/web`): crea solicitudes, muestra estado y envía el link (copiar o WhatsApp `wa.me`).

**Deudas que NO están resueltas** (no dar por cumplido §7 hasta cerrarlas):

- **La cámara solo se probó con una cámara sintética** inyectada en el navegador. Falta probar en
  celulares reales (sobre todo iOS/Safari y Android de gama baja) y con conexiones lentas: permisos,
  resolución real que entrega el dispositivo y el piso de 1280×720.
- **Sin RLS**: el aislamiento entre tenants depende de que cada consulta filtre por `tenant_id`.
- **`tenants.webhook_secret` en claro** en la base, y **el webhook al host no está implementado**.
- **Sin límites por IP** en los endpoints públicos (el OTP y el desafío tienen topes por solicitud; el
  token del link tiene 256 bits). Falta un limitador por IP delante.
- **La revisión humana de la foto no tiene pantalla**: el panel todavía no muestra la foto ni baja el
  PDF (la API ya los sirve en `GET /v1/requests/:id/photo` y `/document`). Tampoco hay un campo para
  marcar «verificada por el corredor».
- **El código de la foto lo compara una persona**, no se lee automáticamente (OCR) ni se compara el
  rostro con el DNI (fase 2).
- **Las plantillas por defecto son BORRADOR**: `legalReviewed: false` y la cláusula lleva «[BORRADOR:
  texto sujeto a revisión legal]». Por defecto la carta exige OTP, foto y desafío.
- **Aún no disponibles:** envío del link por el servicio (`delivery.mode=SERVICE`) y OTP por SMS o
  WhatsApp; se rechazan con `CHANNEL_NOT_AVAILABLE`.
- **El panel entra con la clave de API del tenant** (sin usuarios): solo para uso local y de prueba;
  no exponerlo a otras personas. La clave queda en el `localStorage` del navegador.
- Maquetación del PDF: la constancia queda en su propia página tras el anexo, con espacio en blanco.

**Para producción (esta PC es el servidor):**

- Proceso nuevo en PM2 y ruta nueva en el túnel de Cloudflare. **La cámara exige HTTPS** (o localhost):
  sin HTTPS el navegador no la ofrece.
- Variables: `TOKEN_SECRET`, `SECRETS_KEY` (respaldarla donde estén los demás secretos: si se pierde, lo
  cifrado es irrecuperable), `STORAGE_DIR` (con respaldo), `PUBLIC_BASE_URL`, `TRUST_PROXY=1` (sin esto
  la IP de la evidencia sería la del túnel). `ALLOW_DEV_OTP` debe quedar en `false`: el arranque se
  niega a combinarlo con `NODE_ENV=production`.
- Puertos de desarrollo: API 4000, panel 5180 (`strictPort`; el 5173 es la web de Polix en producción).
