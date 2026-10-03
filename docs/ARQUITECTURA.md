# Arquitectura

## 1. Principios

1. **Independiente del host.** Recibe un snapshot, no consulta la base del cliente. Cualquier
   sistema que sepa llamar una API REST y recibir un webhook puede usarlo.
2. **Multi-tenant y multipaís.** Plantilla, textos legales, logo, datos del corredor e idioma son
   configuración del tenant. Nada de una práctica de mercado fijada en código.
3. **Evidencia sobre apariencia.** Una firma vale lo que valga su paquete de evidencia; el PDF es
   solo la cara visible.
4. **Canales intercambiables.** Email, SMS y WhatsApp son implementaciones de una misma interfaz.

## 2. Pila

NestJS + PostgreSQL (SQL a mano, ver `src/db/schema.sql`), `pdf-lib` para el PDF, SPA mínima
React/Vite para la página de firma servida por el propio servicio. Almacenamiento con proveedor
intercambiable (disco local o S3). Cola (BullMQ + Redis) para webhooks con reintento y para
expirar cartas.

## 3. Flujo

```
Host ── POST /v1/letters (snapshot, contacto, delivery) ──▶ Servicio
Host ◀── { id, reference, signUrl? } ─────────────────────── Servicio
         (delivery=SERVICE: el servicio envía el link; delivery=HOST: el host lo envía)
Cliente abre signUrl ─▶ pide OTP ─▶ el servicio envía el OTP (SMS/WhatsApp/email)
Cliente ingresa OTP ─▶ ve la carta ─▶ marca facultades ─▶ foto con cámara ─▶ acepta
Servicio: genera PDF final, hash SHA-256, guarda evidencia
Servicio ── webhook letter.signed (PDF + evidencia) ──▶ Host
```

## 4. Envío del link y del OTP

| Qué | Quién lo envía | Cómo se elige |
| --- | --- | --- |
| Link de firma | Servicio **o** host | `delivery: SERVICE \| HOST` al crear la carta |
| OTP | **Siempre el servicio** | `otp.channel: SMS \| WHATSAPP \| EMAIL` + `otp.to` |

Con `delivery=HOST` el host manda el link por el canal que ya use con el cliente (p. ej. su
WhatsApp). El OTP sale por el servicio para que link y código no viajen juntos por el mismo
mensaje: si el host mandara ambos, quien intercepte el mensaje tendría los dos factores.
Recomendación: `otp.to` distinto del canal por el que se envió el link, cuando se pueda.

**Costos y trabas [Probable]:** WhatsApp exige WhatsApp Business API con plantillas aprobadas por
Meta y proveedor de pago; SMS exige un agregador con cobertura Perú. En M1 solo se implementa
`EMAIL`; `SMS` y `WHATSAPP` quedan como interfaces con proveedor por definir (decisión pendiente).

## 5. Estados de la carta

`PENDING → SIGNED` | `REJECTED` | `EXPIRED` | `REVOKED`. Solo `PENDING` puede cambiar; los demás
son terminales. `EXPIRED` lo aplica un job al pasar `expires_at`. Una carta firmada no se edita:
si cambian los datos, se crea otra.

## 6. Paquete de evidencia (mínimo de fase 1, sujeto a la revisión legal)

- OTP verificado: canal, destino enmascarado, fecha/hora, intentos.
- Foto capturada con la cámara (`getUserMedia`, sin selector de archivos), en la mayor resolución
  que dé el dispositivo, con su hash.
- Facultades marcadas y texto de «Observación», tal como las vio el cliente.
- IP, user agent, zona horaria del navegador, timestamp del servidor.
- Hash SHA-256 del PDF final y del snapshot original.
- Texto exacto de la cláusula de aceptación mostrada (versionada).

**Límite conocido [Seguro]:** no se puede impedir técnicamente una cámara virtual o un stream
manipulado. La barrera es de mejor esfuerzo; la defensa real es el conjunto de evidencia y, en
fase 1, la revisión humana del corredor (`SIGNED` = firmado por el cliente; la verificación visual
la registra el host).

## 7. Seguridad y datos personales

- Link con token aleatorio de un solo uso, guardado solo como hash; expira (24–48 h).
- OTP de 6 dígitos con vencimiento corto y tope de intentos; bloqueo por carta y por IP.
- Tenant aislado por clave de API (guardada como hash); RLS por `tenant_id`.
- Foto y PDF **cifrados en reposo**; acceso solo por URLs firmadas de corta vida.
- Webhook firmado con HMAC-SHA256 y reintentos con backoff.
- Retención configurable por tenant; borrado de foto al vencer el plazo, conservando hashes.
- HTTPS obligatorio. Mensajes de error al cliente en español.

## 8. Revisión legal (bloqueante para producción)

Un abogado de seguros y datos personales debe responder por escrito:

1. ¿La SBS acepta carta de nombramiento firmada electrónicamente así? (Confirmar la norma exacta;
   el artículo citado en la especificación original no está verificado.)
2. ¿Qué valor probatorio tiene OTP + foto + IP + hash frente a la Ley 27269 y su reglamento, que
   distinguen firma electrónica de firma digital?
3. Ley 29733: texto de consentimiento expreso, plazo de retención, cifrado exigible y si hay que
   registrar el banco de datos ante la ANPD.

Entregable: opinión escrita + cláusula legal lista para la plantilla. Ajustará §6.

## 9. Plantilla del documento

Deriva del modelo SBS (Anexo I y Anexo A). Puntos que la especificación original no cubría:

- La carta lista **los seguros nombrados** (A, B, C…), no números de póliza.
- Las **facultades** son casillas; el cliente puede restringirlas y escribir una observación. Se
  registran tal como las aceptó.
- El **Anexo A** (obligaciones del corredor, póliza de RC profesional, razón social y código de
  registro) lo pone el corredor: es configuración del tenant, versionada.

## 10. Integración con `gestor_segurov3`

Módulo pequeño en su API: crea la carta con un snapshot del cliente; al recibir el webhook guarda
el PDF vía `documents` y rellena `clients.appointment_letter_date`. Eso se hace en M3 y, por la
regla de «front que depende de API nueva», no se toca `apps/web` hasta que el servicio esté
desplegado.

## 11. Decisiones abiertas

- Proveedor de SMS y de WhatsApp (costo, cobertura, plantillas).
- Dónde se aloja (misma PC con otro proceso PM2 y otra ruta de túnel, o aparte).
- Plazo de retención de la foto.
