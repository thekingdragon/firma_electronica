import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { ApiKeyGuard } from './api-key.guard';
import { MailSettingsController } from './mail-settings.controller';
import { SettingsController } from './settings.controller';
import { TemplatesApiService } from './templates.api';
import { TemplatesController } from './templates.controller';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [MailModule],
  controllers: [TenantsController, TemplatesController, SettingsController, MailSettingsController],
  providers: [TenantsService, ApiKeyGuard, TemplatesApiService],
  exports: [TenantsService, ApiKeyGuard],
})
export class TenantsModule {}
