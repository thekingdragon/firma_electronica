import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { RequestsModule } from './requests/requests.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [ConfigModule, DbModule, TenantsModule, RequestsModule],
  controllers: [HealthController],
})
export class AppModule {}
