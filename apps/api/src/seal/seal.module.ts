import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { SealService } from './seal.service';

@Module({
  imports: [StorageModule],
  providers: [SealService],
  exports: [SealService],
})
export class SealModule {}
