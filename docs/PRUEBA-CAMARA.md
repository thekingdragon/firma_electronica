# Prueba de la cámara en celulares reales

**Estado honesto:** la cámara solo se ha probado con una cámara sintética en el navegador de escritorio y con una laptop. **Nunca en un
celular real.** Es el punto del que más depende que firmen clientes de provincia (equipos antiguos, conexiones lentas, navegadores
distintos). Esta lista sirve para cerrarlo. La lógica que no depende del equipo (marco del documento, pisos de resolución) ya tiene pruebas
automáticas (`npm test -w web`); lo que sigue **solo se puede comprobar con un teléfono en la mano**.

## Qué necesita

- **Al menos dos teléfonos**: un **iPhone** (Safari) y un **Android de gama baja o de unos 3 años** (Chrome). Si hay un tercero con otro
  navegador (Samsung Internet, Firefox), mejor.
- **Una dirección con https.** La cámara del navegador **no funciona** sin https (es una regla del navegador, no del servicio). En desarrollo,
  un túnel de Cloudflare temporal; en producción, la dirección pública definitiva.
- **Un correo que reciba el código de verificación** (la corredora tiene que tener su correo configurado y probado: Ajustes → Correo).
- Un documento de identidad real o un carné cualquiera, y una hoja y lapicero para el código de la foto.

## Cómo hacerla

1. Cree una solicitud desde el panel (Nueva solicitud) a un correo que usted pueda abrir en el teléfono, y copie el enlace.
2. Ábralo **en el teléfono** (no en la computadora), por WhatsApp o por correo. Repita todo el recorrido en **cada** teléfono y en cada navegador.
3. Recorra los pasos como lo haría un cliente y anote **en la tabla de abajo** lo que pase en cada punto.

| # | Qué comprobar | iPhone / Safari | Android bajo / Chrome | Otro |
|---|---|---|---|---|
| 1 | El enlace abre y se lee bien (sin desbordes ni letra diminuta) | | | |
| 2 | El código llega por correo en menos de 1 minuto y se puede copiar | | | |
| 3 | Al pulsar «Activar cámara» el navegador pide permiso **una sola vez** | | | |
| 4 | Selfie: se ve el recuadro de la cabeza y el papel; la vista previa **no está invertida de forma confusa** | | | |
| 5 | Selfie: se puede escribir el código en el papel, sostenerlo y encuadrar sin esfuerzo | | | |
| 6 | Documento (frente): el marco tiene forma de tarjeta, se ve nítido y **se lee el número** en la foto capturada | | | |
| 7 | Documento (reverso): igual que el frente | | | |
| 8 | La foto capturada **no se rechaza por «muy pequeña»** (mensaje de resolución) | | | |
| 9 | Al repetir una foto no vuelve a pedir permiso de cámara | | | |
| 10 | Con luz mala (interior, de noche) la foto sigue siendo legible; anote qué pasa | | | |
| 11 | Con conexión lenta (datos móviles, 3G simulado) el envío termina o muestra un mensaje claro, sin quedarse colgado | | | |
| 12 | Al firmar llega la copia por correo (o, si la revisión está activa, el aviso de que se enviará cuando se verifique) | | | |
| 13 | **Si se niega el permiso de cámara**, el mensaje explica cómo activarlo | | | |
| 14 | Girar el teléfono a horizontal a mitad del paso no rompe la pantalla | | | |

## Qué mirar en la revisión (desde el panel de la corredora)

Después de cada firma de prueba, abra la solicitud en el panel → **Revisión de identidad**:

- ¿La selfie y el documento se ven con claridad suficiente **para verificar a una persona**? (Esa es la prueba que importa, no los píxeles.)
- ¿El código del papel se lee y coincide con el que mostró la pantalla?
- ¿La hora de la firma sale con `(UTC-5)` y es la correcta?
- ¿El panel de integridad dice «Verificada»?

## Si algo falla

- Un equipo concreto no abre la cámara → anote **modelo, versión del sistema y navegador**, y el mensaje exacto que mostró.
- Muchas fotos se rechazan por tamaño → los pisos están en `apps/api/src/sign/photo.ts` (`PHOTO_POLICY`). Bajarlos es una decisión de
  evidencia, no un ajuste: una foto muy pequeña puede no servir para verificar a nadie.
- La vista previa o el recorte salen mal → la lógica está en `apps/web/src/sign/useCamera.ts` y `PhotoStep.tsx`.

**No se da la cámara por probada hasta que esta tabla esté completa en un iPhone y un Android de gama baja.**
