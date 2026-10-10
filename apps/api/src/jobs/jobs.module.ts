import { Module } from '@nestjs/common';
import { SealModule } from '../seal/seal.module';
import { StorageModule } from '../storage/storage.module';
import { WebhookWorker } from '../webhooks/webhook.worker';
import { MaintenanceService } from './maintenance.service';

/** Todo lo que corre solo, en segundo plano: entrega de webhooks, vencimiento y retención. */
@Module({
  imports: [StorageModule, SealModule],
  providers: [WebhookWorker, MaintenanceService],
  exports: [WebhookWorker, MaintenanceService],
})
export class JobsModule {}
