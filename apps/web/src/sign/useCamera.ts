import { useCallback, useEffect, useRef, useState } from 'react';

export interface Captured {
  blob: Blob;
  width: number;
  height: number;
}

export type CameraState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

/** Marca de sesión: la cámara ya se abrió bien en este navegador (para los que no tienen la API de permisos). */
const CAMERA_OK_KEY = 'fes-camera-ok';

/** Proporción de un documento tipo tarjeta (ISO/IEC 7810 ID-1: 85,6 × 54 mm), como el DNI. */
export const CARD_ASPECT = 85.6 / 54;

/**
 * Marco guía del documento dentro de un cuadro de `width`×`height`: el mayor rectángulo con proporción de
 * tarjeta que cabe con un margen. La vista previa lo dibuja y la captura recorta EXACTAMENTE esto.
 */
export function cardFrame(width: number, height: number, aspect: number = CARD_ASPECT): { w: number; h: number } {
  const w = Math.min(width * 0.96, height * 0.96 * aspect);
  return { w, h: w / aspect };
}

/** Mensaje que el firmante puede entender y accionar, por tipo de fallo de la cámara. */
function explain(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'No dio permiso para usar la cámara. Actívelo en la configuración de su navegador (el candado junto a la dirección) y vuelva a intentar.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No se encontró una cámara en este dispositivo. Use un celular o una computadora con cámara.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'La cámara está siendo usada por otra aplicación. Ciérrela y vuelva a intentar.';
  }
  return 'No se pudo abrir la cámara. Vuelva a intentar o use otro navegador.';
}

/**
 * Cámara en vivo del navegador. NO hay alternativa de subir un archivo: la foto debe tomarse en el
 * momento, desde la cámara (ver ARQUITECTURA §6). Los pasos de abrir y capturar son acciones
 * explícitas del firmante, no automáticas.
 */
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>({ status: 'idle' });
  const [mirrored, setMirrored] = useState(true);
  /** Proporción real (ancho/alto) del video: la vista previa se dibuja con ella para que lo que se ve sea lo que se captura. */
  const [aspect, setAspect] = useState<number | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState({ status: 'idle' });
  }, []);

  // Al salir del paso, la cámara se apaga: no debe quedar la luz encendida.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const start = useCallback(async (facingMode: 'user' | 'environment' = 'user') => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({
        status: 'error',
        message: 'La cámara solo funciona en conexiones seguras (https). Abra el enlace desde la dirección segura que le enviaron.',
      });
      return;
    }
    setState({ status: 'starting' });
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Para el documento se pide más resolución: la foto sale recortada al marco y debe quedar legible.
        video: { facingMode, width: { ideal: facingMode === 'environment' ? 3840 : 1920 }, height: { ideal: facingMode === 'environment' ? 2160 : 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play();
      try {
        sessionStorage.setItem(CAMERA_OK_KEY, '1');
      } catch {
        /* sin almacenamiento: no pasa nada */
      }
      setMirrored(facingMode === 'user');
      setAspect(video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : null);
      setState({ status: 'ready' });
    } catch (e) {
      setState({ status: 'error', message: explain(e) });
    }
  }, []);

  /**
   * Abre la cámara SOLO si el firmante ya la había permitido: no muestra ningún aviso ni pide nada nuevo.
   * Devuelve `false` si no lo estaba (entonces hay que usar el botón «Activar la cámara»).
   * Los navegadores sin la API de permisos (Safari) se rigen por una marca guardada tras el primer éxito.
   */
  const startIfAllowed = useCallback(
    async (facingMode: 'user' | 'environment'): Promise<boolean> => {
      let allowed = false;
      try {
        const p = await navigator.permissions.query({ name: 'camera' as PermissionName });
        allowed = p.state === 'granted';
      } catch {
        try {
          allowed = sessionStorage.getItem(CAMERA_OK_KEY) === '1';
        } catch {
          allowed = false;
        }
      }
      if (!allowed) return false;
      await start(facingMode);
      return true;
    },
    [start],
  );

  /** Congela la imagen sin soltar la cámara: repetir la foto no vuelve a pedir permiso. */
  const hold = useCallback(() => {
    videoRef.current?.pause();
  }, []);

  /** Reanuda la vista previa; si la cámara ya se soltó, la abre de nuevo. */
  const resume = useCallback(
    async (facingMode: 'user' | 'environment') => {
      const live = streamRef.current?.getVideoTracks().some((t) => t.readyState === 'live');
      if (live && videoRef.current) {
        try {
          await videoRef.current.play();
          return;
        } catch {
          /* cae a abrirla de nuevo */
        }
      }
      await start(facingMode);
    },
    [start],
  );

  /** Toma el cuadro actual con la resolución real del video, sin espejar (lo que se ve es solo la vista previa). */
  const capture = useCallback(async (crop: number | null = null): Promise<Captured> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) throw new Error('La cámara todavía no está lista.');
    // Con `crop: 'card'` se guarda solo lo que queda dentro del marco guía, no el cuadro completo.
    const full = { w: video.videoWidth, h: video.videoHeight };
    const frame = crop ? cardFrame(full.w, full.h, crop) : full;
    const out = { w: Math.round(frame.w), h: Math.round(frame.h) };
    const sx = Math.round((full.w - out.w) / 2);
    const sy = Math.round((full.h - out.h) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = out.w;
    canvas.height = out.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo procesar la imagen.');
    ctx.drawImage(video, sx, sy, out.w, out.h, 0, 0, out.w, out.h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('No se pudo procesar la imagen.');
    return { blob, width: canvas.width, height: canvas.height };
  }, []);

  return { videoRef, state, mirrored, aspect, start, startIfAllowed, stop, hold, resume, capture };
}

/** Piso de resolución que el servidor exige (ver PHOTO_POLICY): avisar antes de enviar ahorra un viaje. */
export function meetsMinimum(width: number, height: number, kind: 'selfie' | 'id' = 'selfie'): boolean {
  const [long, short] = kind === 'id' ? [1000, 600] : [1280, 720];
  return Math.max(width, height) >= long && Math.min(width, height) >= short;
}
