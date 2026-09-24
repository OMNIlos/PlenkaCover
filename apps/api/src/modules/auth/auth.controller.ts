import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Ip,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { extractBearerToken } from '../../common/auth/bearer';
import { LoginThrottleGuard } from '../../common/auth/login-throttle.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MeResponseDto } from './dto/me-response.dto';

/**
 * Auth surface (V2 S1). `login`/`logout` are public entry points; `me` and `logout`
 * act on the Bearer session. No @RequireCapabilities here — these are identity, not
 * role-gated business actions; `me` guards on actor presence itself.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Post('login')
  @UseGuards(LoginThrottleGuard)
  @Header('Cache-Control', 'no-store')
  login(@Body() dto: LoginDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string) {
    return this.service.login(dto.login, dto.password, { ip, userAgent });
  }

  @Post('change-password')
  @ApiBearerAuth()
  changePassword(@Body() dto: ChangePasswordDto, @CurrentActor() actor?: Actor) {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return this.service.changePassword(actor, dto);
  }

  @Post('logout')
  @ApiBearerAuth()
  logout(@Headers('authorization') authorization?: string) {
    return this.service.logout(extractBearerToken(authorization) ?? '');
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: MeResponseDto })
  me(@CurrentActor() actor?: Actor) {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return this.service.me(actor);
  }
}
