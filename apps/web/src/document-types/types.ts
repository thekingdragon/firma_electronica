import type { ComponentType, ReactNode } from 'react';

/** Los campos propios de un tipo de documento en «Nueva solicitud»: texto por campo, y un error por campo. */
export type Draft = Record<string, string>;

/**
 * La cara en el PANEL de un tipo de documento que el servicio firma (la carta de nombramiento es el primero). El panel
 * (lista, detalle, nueva solicitud, página de firma) no conoce ninguno en particular: solo habla con esta forma.
 * Agregar un tipo = una carpeta aquí y su entrada en `index.ts`.
 */
export interface DocumentTypeUi {
  /** El mismo código que usa la API (`documentType`). */
  code: string;
  name: string;
  /** Nombre del dato en la solicitud que alimenta un bloque «lista de datos» al armar la plantilla (p. ej. `insurances`). */
  defaultListKey?: string;
  emptyDraft(): Draft;
  /** Qué falta en los campos propios del tipo, por campo (vacío si está completo). */
  validate(draft: Draft): Draft;
  /** Los `data` que se mandan a la API. */
  toData(draft: Draft): Record<string, unknown>;
  Fields: ComponentType<{ draft: Draft; errors: Draft; invalid: (k: string) => string; onChange: (key: string, value: string) => void }>;
  /** Encabezado y valor corto de la columna «Detalle» de la lista de solicitudes. */
  summaryLabel: string;
  summary(data: Record<string, unknown>): ReactNode;
  /** Filas (`<dt>/<dd>`) del detalle de una solicitud. */
  detail(data: Record<string, unknown>): ReactNode;
  /** Lo propio del tipo en la pantalla de repaso antes de firmar. */
  reviewSummary(data: Record<string, unknown>): ReactNode;
}
