import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  controllers: [TenantsController],
  providers: [TenantsService, ApiKeyGuard],
  exports: [TenantsService, ApiKeyGuard],
})
export class TenantsModule {}
