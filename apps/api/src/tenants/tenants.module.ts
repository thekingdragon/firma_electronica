import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { TenantsService } from './tenants.service';

@Module({
  providers: [TenantsService, ApiKeyGuard],
  exports: [TenantsService, ApiKeyGuard],
})
export class TenantsModule {}
