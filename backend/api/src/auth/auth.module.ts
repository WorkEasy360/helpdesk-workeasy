import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { AccessControlService } from './access-control.service';
import { Workeasy360Settings } from '../workeasy360/workeasy360.settings';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, AccessControlService, Workeasy360Settings],
  exports: [AuthService, PasswordService, TokenService, AccessControlService, Workeasy360Settings],
})
export class AuthModule {}
