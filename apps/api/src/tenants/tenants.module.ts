import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { TemplatesApiService } from './templates.api';
import { TemplatesController } from './templates.controller';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  controllers: [TenantsController, TemplatesController],
  providers: [TenantsService, ApiKeyGuard, TemplatesApiService],
  exports: [TenantsService, ApiKeyGuard],
})
export class TenantsModule {}
