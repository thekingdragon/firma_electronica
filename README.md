# carta-nombramiento-service

Microservicio que genera cartas de nombramiento de corredor de seguros (modelo SBS, Anexo I y
Anexo A), las hace firmar al cliente desde su navegador y devuelve el PDF firmado con un paquete
de evidencia. Independiente de cualquier sistema: el sistema que lo usa (el «host») le manda un
snapshot de los datos y recibe un webhook cuando el cliente firma. No lee la base del host.

## Estado

**M0 — diseño.** Aún no hay código ejecutable. Ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md),
[docs/openapi.yaml](docs/openapi.yaml) y [src/db/schema.sql](src/db/schema.sql).

## ⚠️ No usar con clientes reales todavía

Falta la **revisión legal** (ver ARQUITECTURA §8). Hasta tener la opinión escrita, ninguna carta
firmada por este servicio debe darse por válida ante la SBS.

## Método de trabajo

- Ramas de trabajo; `main` solo recibe lo cerrado. Commits en español, en imperativo, describiendo
  el efecto. Se commitea y se hace push al cerrar cada tarea.
- Hitos (cada uno cierra con commit + push):
  - **M0** diseño: arquitectura, contrato OpenAPI, esquema SQL.
  - **M1** API central: máquina de estados, generación de PDF, webhook. Con pruebas.
  - **M2** página de firma: OTP, cámara, facultades.
  - **M3** módulo de integración en `gestor_segurov3`.
  - **M4** endurecimiento y piloto.
- Fase 2 (fuera de alcance inicial): OCR del DNI y reconocimiento facial.
- Las migraciones se escriben a mano en SQL y llevan número correlativo en `migrations/`.
