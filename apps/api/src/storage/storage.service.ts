import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { openBytes, sealBytes } from '../common/secret-box';
import { APP_CONFIG, AppConfig } from '../config/config';

/**
 * En Windows, `rename` puede fallar un instante con EPERM/EBUSY/EACCES si el antivirus, el indexador
 * u otro proceso tiene el destino abierto. Un reintento corto lo resuelve; otros errores no se reintentan.
 */
async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 15 * i));
    }
  }
}

/** No hay clave maestra: no se puede guardar nada cifrado. Es una falla de configuración, no del usuario. */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super('Falta SECRETS_KEY: no se pueden guardar archivos cifrados.');
    this.name = 'StorageNotConfiguredError';
  }
}

/**
 * Archivos cifrados en disco (la foto de identidad y el PDF firmado). Se guardan con AES-256-GCM y la
 * subclave `files`: quien se lleve el directorio o un respaldo no puede leerlos sin SECRETS_KEY.
 * Las rutas son relativas al directorio de almacenamiento y las arma el código a partir de ids
 * (UUID), nunca a partir de lo que mande el usuario.
 */
@Injectable()
export class StorageService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private key(): Buffer {
    if (!this.config.secretsKey) throw new StorageNotConfiguredError();
    return this.config.secretsKey;
  }

  /** Resuelve la ruta y exige que quede DENTRO del directorio de almacenamiento. */
  private absolute(relPath: string): string {
    const root = resolve(this.config.storageDir);
    const full = resolve(join(root, relPath));
    if (full !== root && !full.startsWith(root + sep)) throw new Error('Ruta de almacenamiento inválida.');
    return full;
  }

  /** Cifra y guarda. La escritura es atómica: o queda el archivo completo o no queda nada. */
  async put(relPath: string, plain: Buffer): Promise<void> {
    const sealed = sealBytes(this.key(), 'files', plain);
    const full = this.absolute(relPath);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.${randomUUID()}.tmp`;
    await writeFile(tmp, sealed, { flag: 'wx' });
    try {
      await renameWithRetry(tmp, full);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /** Lee y descifra. Lanza si el archivo no existe, fue alterado o la clave no coincide. */
  async get(relPath: string): Promise<Buffer> {
    return openBytes(this.key(), 'files', await readFile(this.absolute(relPath)));
  }

  /** Borra sin fallar si ya no está (se usa para deshacer una escritura cuando la transacción falla). */
  async remove(relPath: string): Promise<void> {
    await rm(this.absolute(relPath), { force: true });
  }
}
