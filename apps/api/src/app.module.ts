import { Module } from '@nestjs/common';
import { RateLimitModule } from './common/rate-limit';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { RequestsModule } from './requests/requests.module';
import { SignModule } from './sign/sign.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [ConfigModule, RateLimitModule, DbModule, TenantsModule, RequestsModule, SignModule, JobsModule],
  controllers: [HealthController],
})
export class AppModule {}
