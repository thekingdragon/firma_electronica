# firma-electronica-service

Microservicio de firma electrónica por solicitud: el firmante recibe un link, verifica su acceso
(OTP), completa el formulario del documento y firma desde su navegador; el servicio devuelve el
PDF firmado con un paquete de evidencia. Es genérico por **tipo de documento** y se enfoca primero
en la **carta de nombramiento de corredor de seguros** (modelo SBS, Anexo I y Anexo A).

Independiente de cualquier sistema: el sistema que lo usa (el «host») le manda un snapshot de los
datos y recibe un webhook cuando el firmante firma. No lee la base del host.

## Estado

**M1/M2 funcionando de punta a punta en local**: crear solicitud → OTP → documento → foto con código → firma → PDF cifrado. Quedan deudas serias (cámara probada solo con una sintética, webhook, revisión humana en el panel, RLS): ver ARQUITECTURA §13.
[docs/openapi.yaml](docs/openapi.yaml) y [apps/api/migrations/0000_inicial.sql](apps/api/migrations/0000_inicial.sql) (el SQL se validó
contra un Postgres temporal: crea las 9 tablas sin errores).

## ⚠️ No usar con clientes reales todavía

Falta la **revisión legal** (ver ARQUITECTURA §8). Hasta tener la opinión escrita, ninguna firma
hecha con este servicio debe darse por válida ante la SBS.

## Alcance

- **Fase 1:** carta de nombramiento; link + OTP por correo (SMTP propio de cada tenant); foto con
  desafío aleatorio opcional por política; PDF con hash; webhook; revisión humana en el host.
- **Fase 2 (después de ver la fase 1 funcionando):** SMS y WhatsApp, prueba de vida y comparación
  biométrica (detrás de `IdentityVerifier`), OCR del código como señal, otros tipos de documento.

## Uso en desarrollo

```
cp apps/api/.env.example apps/api/.env      # completar DATABASE_URL, TOKEN_SECRET, PUBLIC_BASE_URL
npm install
npm run db:migrate
npm run tenant:create -w api -- --name "Mi Corredora" --country PE --legal-name "Mi Corredora SAC"
npm run dev                                  # API en :4000
npm run dev -w web                           # panel en http://127.0.0.1:5180
```

El panel (`apps/web`) pide la clave de API del tenant. Es una solución provisional para uso local:
ver ARQUITECTURA §13 antes de exponerlo.

`tenant:create` imprime la clave de API una sola vez; guárdala. Las pruebas unitarias son
`npm test`. Las de integración (`npm run test:e2e -w api`) necesitan `TEST_DATABASE_URL` apuntando a
una base vacía cuyo nombre termine en `_test`: la prueba la vacía.

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
- Las migraciones se escriben a mano en SQL y llevan número correlativo en `apps/api/migrations/`.
