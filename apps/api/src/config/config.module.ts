import { Global, Module } from '@nestjs/common';
import * as dotenv from 'dotenv';
import { APP_CONFIG, loadConfig } from './config';

dotenv.config();

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
