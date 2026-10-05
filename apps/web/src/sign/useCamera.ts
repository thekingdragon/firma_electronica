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
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
      setMirrored(facingMode === 'user');
      setAspect(video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : null);
      setState({ status: 'ready' });
    } catch (e) {
      setState({ status: 'error', message: explain(e) });
    }
  }, []);

  /** Toma el cuadro actual con la resolución real del video, sin espejar (lo que se ve es solo la vista previa). */
  const capture = useCallback(async (): Promise<Captured> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) throw new Error('La cámara todavía no está lista.');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo procesar la imagen.');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('No se pudo procesar la imagen.');
    return { blob, width: canvas.width, height: canvas.height };
  }, []);

  return { videoRef, state, mirrored, aspect, start, stop, capture };
}

/** Piso de resolución que el servidor exige (ver PHOTO_POLICY): avisar antes de enviar ahorra un viaje. */
export function meetsMinimum(width: number, height: number): boolean {
  return Math.max(width, height) >= 1280 && Math.min(width, height) >= 720;
}
