import { Global, Module } from '@nestjs/common';
import * as dotenv from 'dotenv';
import { APP_CONFIG, loadConfig } from './config';

// En las pruebas el entorno lo arma cada prueba (ver db.module.ts).
if (process.env.NODE_ENV !== 'test') dotenv.config();

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
