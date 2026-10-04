import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { TenantsModule } from '../tenants/tenants.module';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';

@Module({
  imports: [TenantsModule, StorageModule],
  controllers: [RequestsController],
  providers: [RequestsService],
})
export class RequestsModule {}
