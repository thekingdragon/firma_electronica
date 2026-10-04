import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [DbModule],
  controllers: [HealthController],
})
export class AppModule {}
