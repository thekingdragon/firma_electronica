import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { SignController } from './sign.controller';
import { SignService } from './sign.service';

@Module({
  imports: [MailModule],
  controllers: [SignController],
  providers: [SignService],
})
export class SignModule {}
