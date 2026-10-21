import {
  agentClaimRequestSchema,
  agentHeartbeatRequestSchema,
  agentResultRequestSchema,
  agentStartRequestSchema,
  type AgentClaim,
  type AgentHeartbeat,
  type AgentHeartbeatRequest,
  type AgentJobState,
  type AgentResultRequest,
  type AgentStartRequest,
} from '@ayvo/types';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Headers,
  StreamableFile,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentAgent, PrintAgentAccess, type AgentPrincipal } from './print-agent.guard.js';
import { PrintQueueService } from './print-queue.service.js';

/**
 * The print agent's API (ADR 0028, doc 030 §5) — machines only, header `X-Ayvo-Print-Agent`. An
 * agent sees only its own printers' jobs and only the stored ZPL of a job it holds.
 */
@Controller('agent/v1')
export class AgentController {
  constructor(private readonly queue: PrintQueueService) {}

  @PrintAgentAccess()
  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(
    @CurrentAgent() agent: AgentPrincipal,
    @Body(new ZodValidationPipe(agentHeartbeatRequestSchema)) body: AgentHeartbeatRequest,
  ): Promise<AgentHeartbeat> {
    return this.queue.heartbeat(agent, body);
  }

  @PrintAgentAccess()
  @Post('jobs/claim')
  @HttpCode(200)
  claim(
    @CurrentAgent() agent: AgentPrincipal,
    @Body(new ZodValidationPipe(agentClaimRequestSchema)) _body: object,
  ): Promise<AgentClaim> {
    return this.queue.claim(agent);
  }

  /** The claim token travels in a header (never in a URL that proxies may log). */
  @PrintAgentAccess()
  @Get('jobs/:id/data')
  async data(
    @CurrentAgent() agent: AgentPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('x-ayvo-claim') claim: string | undefined,
  ): Promise<StreamableFile> {
    const bytes = await this.queue.data(agent, id, String(claim ?? ''));
    return new StreamableFile(bytes, { type: 'application/zpl', disposition: 'attachment' });
  }

  @PrintAgentAccess()
  @Post('jobs/:id/start')
  @HttpCode(200)
  start(
    @CurrentAgent() agent: AgentPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(agentStartRequestSchema)) body: AgentStartRequest,
  ): Promise<AgentJobState> {
    return this.queue.start(agent, id, body.claimToken);
  }

  @PrintAgentAccess()
  @Post('jobs/:id/result')
  @HttpCode(200)
  result(
    @CurrentAgent() agent: AgentPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(agentResultRequestSchema)) body: AgentResultRequest,
  ): Promise<AgentJobState> {
    return this.queue.result(agent, id, body);
  }
}
