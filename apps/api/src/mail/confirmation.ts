import type { MailMessage } from './mail.service';

/** El correo con la copia firmada que recibe el firmante. Lo usan la firma y, cuando la plantilla exige revisión, la aprobación. */
export function confirmationMessage(input: { to: string; reference: string; legalName: string; pdf: Buffer }): MailMessage {
  return {
    to: input.to,
    subject: `Su documento firmado ${input.reference}`,
    text:
      `Adjuntamos la copia de su documento ${input.reference}, firmado electrónicamente.\n\n` +
      `Guárdela: es su constancia. Si usted no firmó este documento, comuníquese de inmediato con ${input.legalName}.`,
    attachments: [{ filename: `${input.reference}.pdf`, content: input.pdf, contentType: 'application/pdf' }],
  };
}
