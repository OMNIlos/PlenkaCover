import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { GatewayService } from './gateway.service';
import { GatewayAuthGuard } from './gateway-auth.guard';
import { CurrentPost, type GatewayPost } from './current-post.decorator';
import { CommandResultDto, HeartbeatDto, IngestDto } from './dto/gateway.dto';

/**
 * Agent-facing side of the gateway protocol (V2 S4). The agent initiates all calls (outbound
 * channel, no port-forwarding): heartbeat + poll commands + post results + push ingest. Gated by
 * GatewayAuthGuard (agent token), not the user capability model.
 */
@ApiTags('gateway')
@ApiSecurity('agent-token')
@Controller('gateway')
@UseGuards(GatewayAuthGuard)
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  @Post('heartbeat')
  heartbeat(@CurrentPost() post: GatewayPost, @Body() dto: HeartbeatDto) {
    return this.gateway.heartbeat(post.id, dto);
  }

  @Get('commands')
  commands(@CurrentPost() post: GatewayPost) {
    return this.gateway.pollCommands(post.id);
  }

  @Post('commands/:id/result')
  async result(
    @CurrentPost() post: GatewayPost,
    @Param('id') id: string,
    @Body() dto: CommandResultDto,
  ) {
    return this.gateway.resolveCommand(id, dto.result, post.id, dto.leaseToken);
  }

  @Post('ingest')
  ingest(@CurrentPost() post: GatewayPost, @Body() dto: IngestDto) {
    return this.gateway.ingest(post.id, dto);
  }
}
