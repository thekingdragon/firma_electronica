# firma-electronica-service

Microservicio de firma electrónica por solicitud: el firmante recibe un enlace, verifica su acceso con
un código (OTP), lee y completa el documento, se toma una foto en el momento con su documento de
identidad y firma desde su navegador; el servicio devuelve el PDF firmado con un paquete de evidencia.
Es genérico por **tipo de documento** y se enfoca primero en la **carta de nombramiento de corredor de
seguros** (modelo SBS, Anexo I y Anexo A).

Independiente de cualquier sistema: el sistema que lo usa (el «host») le manda un snapshot de los datos
y recibe avisos por webhook. No lee la base del host. Trae además un **panel propio** para quien lo use
sin un sistema detrás.

## Estado

**Versión 1 completa en este repositorio, probada de punta a punta en local.** La API tiene pruebas
unitarias y de integración contra PostgreSQL y un SMTP reales; el front se verificó a mano en el
navegador. Lo que **no** está hecho, y por qué, está en [docs/ARQUITECTURA.md §13](docs/ARQUITECTURA.md).
Las tres cosas que más pesan:

- **La cámara solo se probó con una cámara sintética** de escritorio. Falta probar en celulares reales.
- **Falta la revisión legal.** Las plantillas nacen en BORRADOR.
- **La integración con Polix no está hecha** (necesita aprobación de quien lo mantiene).

## ⚠️ No usar con clientes reales todavía

Falta la **revisión legal** (ARQUITECTURA §8). Hasta tener la opinión escrita y publicar el texto
definitivo (`template:publish`), ninguna firma hecha con este servicio debe darse por válida ante la SBS.

## Qué hace

- Crear solicitudes por **API** o desde el **panel**; enviar el enlace por el host (copiar o WhatsApp) o
  **por correo desde el servicio**.
- Verificación por **OTP por correo** (SMTP propio de cada corredora), con tope de intentos.
- **Fotos en vivo** (sin subir archivos): el **documento de identidad** (frente y reverso) y una **selfie** con un **código aleatorio**
  escrito en un papel. Cada una es una política de la plantilla, configurable desde el panel.
- **PDF firmado** con constancia (foto, hash, IP, hora), **cifrado en disco**; copia al firmante por correo.
- **Revisión humana** de la identidad en el panel; **revocar**; **vencimiento** automático.
- **Webhooks** firmados al host (`signature.signed|reviewed|revoked|expired`), con reintentos.
- **Plantillas por bloques editables desde el panel** (texto, ramos, facultades, consentimientos, anexos, variables),
  versionadas y con vista previa en PDF; **aviso de datos personales** al pie de los correos (panel › Ajustes); política de evidencia por tipo de documento; retención de fotos.

## Documentación

| Documento | Para qué |
| --- | --- |
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Diseño, seguridad, marco legal y **deudas conocidas**. |
| [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md) | Poner el servicio en producción en esta PC. |
| [docs/WEBHOOKS.md](docs/WEBHOOKS.md) | Cómo recibir y verificar los avisos (con código). |
| [docs/openapi.yaml](docs/openapi.yaml) | Contrato de la API (una prueba lo compara con la API real). |

## Uso en desarrollo

```
cp apps/api/.env.example apps/api/.env      # completar DATABASE_URL, TOKEN_SECRET, SECRETS_KEY, PUBLIC_BASE_URL
npm install
npm run db:migrate
npm run tenant:create -w api -- --name "Mi Corredora" --country PE --legal-name "Mi Corredora SAC"
npm run dev                                  # API en :4000
npm run dev -w web                           # panel en http://127.0.0.1:5180 (reenvía /v1 a la API)
```

`tenant:create` imprime la clave de API y el secreto de webhook **una sola vez**; guárdalos. El panel
pide la clave de API del tenant (ver ARQUITECTURA §13 sobre su alcance). Sin correo configurado el
firmante no recibe el código: para probar en local puede usarse `ALLOW_DEV_OTP=true` (el código aparece
en la pantalla; el arranque se niega a combinarlo con producción) o configurar un SMTP con
`tenant:mail`.

Comandos de administración (`npm run <comando> -w api -- <opciones>`): `tenant:create`, `tenant:mail`,
`tenant:webhook`, `template:publish` y `db:migrate`. No tienen `--help`: cada uno documenta sus opciones
y trae un ejemplo en el comentario de cabecera de su archivo (`apps/api/src/tenants/*.ts` y
`apps/api/src/db/migrate.ts`). [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md) los usa en orden.

## Pruebas

```
npm test                  # unitarias
npm run test:e2e          # integración: necesita TEST_DATABASE_URL
```

`TEST_DATABASE_URL` debe apuntar a una base vacía cuyo nombre termine en `_test`: la prueba la vacía.
Las de integración levantan un servidor SMTP real de captura y un receptor de webhooks, y comprueban
el aislamiento entre tenants, la concurrencia (doble firma, intentos en paralelo), el contrato OpenAPI
contra las rutas reales y las cabeceras de seguridad.

## Método de trabajo

- Ramas de trabajo; `main` solo recibe lo cerrado. Commits en español, en imperativo, describiendo el
  efecto. Se commitea y se hace push al cerrar cada tarea.
- Las migraciones se escriben a mano en SQL y llevan número correlativo en `apps/api/migrations/`.
- Fase 2 (después de ver la fase 1 funcionando con clientes reales): SMS y WhatsApp, prueba de vida y
  comparación biométrica (detrás de `IdentityVerifier`), OCR del código como señal, otros tipos de
  documento.
