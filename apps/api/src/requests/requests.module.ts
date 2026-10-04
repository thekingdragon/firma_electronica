import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';

@Module({
  imports: [TenantsModule],
  controllers: [RequestsController],
  providers: [RequestsService],
})
export class RequestsModule {}
