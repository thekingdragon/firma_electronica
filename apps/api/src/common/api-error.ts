import { HttpException } from '@nestjs/common';

/** Error de la API con un `code` estable para que el host programe contra él, no contra el texto. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super({ code, message, ...extra }, status);
  }
}
