import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { SealModule } from '../seal/seal.module';
import { StorageModule } from '../storage/storage.module';
import { SignController } from './sign.controller';
import { SignService } from './sign.service';
import { SubmitService } from './submit.service';

@Module({
  imports: [MailModule, StorageModule, SealModule],
  controllers: [SignController],
  providers: [SignService, SubmitService],
})
export class SignModule {}
