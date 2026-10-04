# Webhooks: cómo recibir los avisos del servicio

El servicio avisa a su sistema (el «host») cuando cambia el estado de una solicitud, sin que tenga
que consultar. Esta es la referencia para quien programa el receptor.

## Configurar

La URL y el secreto se configuran por tenant con el comando (en el servidor del servicio):

```
npm run tenant:webhook -w api -- --tenant <uuid> --url https://su-sistema.com/hooks/firma --rotate
```

- `--rotate` genera un secreto nuevo (`whsec_…`) y lo imprime **una sola vez**; en la base queda
  cifrado. El anterior deja de servir de inmediato.
- `--url ""` desactiva los avisos.
- Una solicitud puede traer su propio `webhookUrl` al crearse; manda sobre la del tenant.
- En producción la URL debe ser `https` y **pública**: el servicio no llama a direcciones privadas ni
  de loopback (10.x, 192.168.x, 127.x, 169.254.x, etc.), aunque un nombre de dominio resuelva a ellas.
  No sigue redirecciones.

## Eventos

| Evento | Cuándo |
| --- | --- |
| `signature.signed` | El firmante firmó. El PDF y la foto ya se pueden bajar. |
| `signature.reviewed` | Alguien del corredor registró (o corrigió) su dictamen sobre la identidad. |
| `signature.revoked` | La solicitud pendiente se revocó. |
| `signature.expired` | La solicitud pendiente venció sin firmarse. |

## La petición

`POST` a su URL, `Content-Type: application/json`, con estas cabeceras:

| Cabecera | Contenido |
| --- | --- |
| `X-Webhook-Id` | Id único del evento (el mismo en cada reintento). **Úselo para no procesar dos veces.** |
| `X-Webhook-Event` | El tipo de evento. |
| `X-Signature` | `t=<unix>,v1=<hex>`: firma HMAC-SHA256 (ver abajo). |

Cuerpo:

```json
{
  "event": "signature.signed",
  "id": "0d9e0c0e-…",
  "occurredAt": "2026-10-04T22:20:30.512Z",
  "data": {
    "requestId": "b4d04d47-…",
    "reference": "FE-2026-GHXKJDCX",
    "documentType": "APPOINTMENT_LETTER",
    "externalRef": "su-codigo-de-cliente",
    "status": "SIGNED",
    "signedAt": "2026-10-04T22:20:30.352Z",
    "pdfSha256": "d2c124a1…",
    "documentPath": "/v1/requests/b4d04d47-…/document",
    "photoPath": "/v1/requests/b4d04d47-…/photo",
    "review": null
  }
}
```

- `documentPath` y `photoPath` son rutas de la API del servicio: se bajan con **su clave de API**
  (`X-Api-Key`). No hay enlaces firmados que puedan filtrarse. Son `null` si no aplican.
- `review` trae `{ result, reviewedBy, note, reviewedAt }` en `signature.reviewed`; antes es `null`.
- El cuerpo se **congela** al registrar el evento: un reintento envía exactamente lo mismo.

## Verificar la firma (obligatorio)

Sin verificarla, cualquiera que conozca su URL puede inventar firmas. La firma es
`HMAC-SHA256(secreto, "<t>.<cuerpo exacto>")`, donde `t` es el número de `t=` de la cabecera y el
cuerpo son los **bytes crudos** recibidos (no lo re-serialice: cambiaría la firma).

1. Separe `t` y `v1` de `X-Signature`.
2. Rechace si `|ahora − t| > 300` segundos (evita repeticiones de un mensaje capturado).
3. Calcule el HMAC y compárelo con `v1` **en tiempo constante**.

Node.js:

```js
const crypto = require('crypto');

function verificar(secreto, cabecera, cuerpoCrudo, toleranciaSeg = 300) {
  const partes = Object.fromEntries(cabecera.split(',').map((p) => p.trim().split('=')));
  const t = Number(partes.t);
  if (!Number.isInteger(t) || !partes.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranciaSeg) return false;
  const esperado = crypto.createHmac('sha256', secreto).update(`${t}.${cuerpoCrudo}`).digest();
  const recibido = Buffer.from(partes.v1, 'hex');
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}
```

Con Express, para tener el cuerpo crudo use `express.raw({ type: 'application/json' })` en esa ruta.

PHP:

```php
function verificar(string $secreto, string $cabecera, string $cuerpo, int $tolerancia = 300): bool {
    parse_str(str_replace(',', '&', $cabecera), $p);
    if (!isset($p['t'], $p['v1']) || abs(time() - (int)$p['t']) > $tolerancia) return false;
    $esperado = hash_hmac('sha256', $p['t'] . '.' . $cuerpo, $secreto);
    return hash_equals($esperado, $p['v1']);
}
```

Vector de prueba para validar su implementación:

```
secreto : whsec_golden_test_secret_0123456789abcdef
t       : 1800000000
cuerpo  : {"event":"signature.signed","id":"d1","data":{"reference":"FE-2026-ABCD1234"}}
v1      : a052bc8e2765ce004c1d4d25e1629ebf37ca4f03e5198f4c1011934f2995e3e3
```

## Responder

- Conteste **2xx** en cuanto lo haya recibido y guardado; haga el trabajo pesado después. El servicio
  espera hasta 10 segundos.
- Cualquier otra cosa (error de red, 3xx, 4xx, 5xx, timeout) cuenta como fallo y se reintenta.

## Reintentos y garantías

- Entrega **«al menos una vez»**: puede llegar repetido (un 2xx que se perdió en el camino). Deduplique
  por `X-Webhook-Id`.
- Espera entre intentos: 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h. Tras el 9.º intento (unas
  23 horas) se da por **fallido**; el servicio no insiste más. Los fallidos quedan en la tabla
  `webhook_deliveries` (`failed_at`, `last_error`).
- **El orden no está garantizado** entre eventos de una misma solicitud, sobre todo si hubo reintentos.
  Use `status`, `occurredAt` y, ante la duda, consulte `GET /v1/requests/{id}`.
- El evento se registra en la misma transacción que el cambio (firma, revocación…): no se pierde si el
  servicio se reinicia, ni se emite por un cambio que se deshizo.

## Si deja de recibir avisos

1. Revise `last_error` en `webhook_deliveries` (tabla del servicio) para ese evento.
2. «El tenant no tiene secreto de webhook configurado» → corra `tenant:webhook --rotate`.
3. «no pública» → la URL apunta a una dirección interna: use una URL pública con `https`.
4. Rotó el secreto y sigue fallando su verificación → asegúrese de usar el secreto **nuevo**.
