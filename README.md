# firma-electronica-service

Microservicio de firma electrónica por solicitud: el firmante recibe un link, verifica su acceso
(OTP), completa el formulario del documento y firma desde su navegador; el servicio devuelve el
PDF firmado con un paquete de evidencia. Es genérico por **tipo de documento** y se enfoca primero
en la **carta de nombramiento de corredor de seguros** (modelo SBS, Anexo I y Anexo A).

Independiente de cualquier sistema: el sistema que lo usa (el «host») le manda un snapshot de los
datos y recibe un webhook cuando el firmante firma. No lee la base del host.

## Estado

**M0 — diseño.** Aún no hay código ejecutable. Ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md),
[docs/openapi.yaml](docs/openapi.yaml) y [src/db/schema.sql](src/db/schema.sql) (el SQL se validó
contra un Postgres temporal: crea las 9 tablas sin errores).

## ⚠️ No usar con clientes reales todavía

Falta la **revisión legal** (ver ARQUITECTURA §8). Hasta tener la opinión escrita, ninguna firma
hecha con este servicio debe darse por válida ante la SBS.

## Alcance

- **Fase 1:** carta de nombramiento; link + OTP por correo (SMTP propio de cada tenant); foto con
  desafío aleatorio opcional por política; PDF con hash; webhook; revisión humana en el host.
- **Fase 2 (después de ver la fase 1 funcionando):** SMS y WhatsApp, prueba de vida y comparación
  biométrica (detrás de `IdentityVerifier`), OCR del código como señal, otros tipos de documento.

## Método de trabajo

- Ramas de trabajo; `main` solo recibe lo cerrado. Commits en español, en imperativo, describiendo
  el efecto. Se commitea y se hace push al cerrar cada tarea.
- Hitos (cada uno cierra con commit + push):
  - **M0** diseño: arquitectura, contrato OpenAPI, esquema SQL.
  - **M1** API central: máquina de estados, generación de PDF, correo por tenant, webhook. Con
    pruebas.
  - **M2** página de firma: OTP, cámara, desafío, formulario.
  - **M3** módulo de integración en `gestor_segurov3`.
  - **M4** endurecimiento y piloto.
- Las migraciones se escriben a mano en SQL y llevan número correlativo en `migrations/`.
