/** Todo lo que un generador de documento necesita; no depende de la base ni de Nest. */
export interface RenderInput {
  reference: string;
  issuer: { legalName: string; registryCode: string | null };
  signer: { name: string; documentType: string; documentNumber: string };
  /** Datos propios del tipo de documento (en la carta: `insurances`). */
  data: Record<string, unknown>;
  /** `body_json` de la plantilla: contenido y textos. */
  content: Record<string, unknown>;
  annexText: string | null;
  clauseText: string;
  /** Lo que el firmante marcó o escribió en el formulario. */
  form: { powers: string[]; observation: string; consents?: string[] };
  signedAt: Date;
  evidence: {
    ip: string | null;
    otpVerifiedAt: Date | null;
    challengeCode: string | null;
    photo: { bytes: Buffer; type: 'jpeg' | 'png'; width: number; height: number; sha256: string } | null;
    /** Foto del documento de identidad; `undefined` si la plantilla no la pide. */
    idPhoto?: { bytes: Buffer; type: 'jpeg' | 'png'; width: number; height: number; sha256: string } | null;
    /** Reverso del documento de identidad; `undefined` si la plantilla no lo pide. */
    idPhotoBack?: { bytes: Buffer; type: 'jpeg' | 'png'; width: number; height: number; sha256: string } | null;
  };
}

export type DocumentRenderer = (input: RenderInput) => Promise<Uint8Array>;
