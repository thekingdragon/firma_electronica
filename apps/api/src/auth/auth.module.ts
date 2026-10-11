import { Global, Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { AccessGuard } from './access.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { PasswordResetService } from './password-reset.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Global()
@Module({
  imports: [MailModule],
  controllers: [AuthController, UsersController],
  providers: [AuthService, MfaService, PasswordResetService, UsersService, AccessGuard],
  exports: [AuthService, MfaService, UsersService, AccessGuard],
})
export class AuthModule {}
