import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { StorageModule } from '../storage/storage.module';
import { TenantsModule } from '../tenants/tenants.module';
import { RequestActionsService } from './request-actions.service';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';

@Module({
  imports: [TenantsModule, StorageModule, MailModule],
  controllers: [RequestsController],
  providers: [RequestsService, RequestActionsService],
})
export class RequestsModule {}
