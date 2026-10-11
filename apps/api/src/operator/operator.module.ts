import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { OperatorController } from './operator.controller';
import { OperatorGuard } from './operator.guard';
import { OperatorService } from './operator.service';

@Module({
  imports: [StorageModule],
  controllers: [OperatorController],
  providers: [OperatorService, OperatorGuard],
})
export class OperatorModule {}
