import {
  applyDecorators,
  createParamDecorator,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { domainError } from '../common/domain-error.js';
import { PrismaService } from '../database/prisma.service.js';
import { ACCESS_METADATA, type AccessRule } from '../identity/access.decorators.js';
import { AGENT_HEADER, agentTokenHash, isAgentToken } from './agent-token.js';

/** The authenticated print agent of a request (never a user). */
export interface AgentPrincipal {
  id: string;
  code: string;
  siteId: string;
  siteCode: string;
}
type RequestWithAgent = IncomingMessage & { ayvoAgent?: AgentPrincipal };

const agentUnauthorized = () =>
  domainError(401, 'AGENT_UNAUTHORIZED', 'A valid print agent token is required');

/**
 * Checks the print agent's token (ADR 0028): only from the `X-Ayvo-Print-Agent` header, looked up
 * by its SHA-256 hash; a revoked agent is refused. Never reads a user session.
 */
@Injectable()
export class PrintAgentGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithAgent>();
    const token = req.headers[AGENT_HEADER];
    if (!isAgentToken(token)) throw agentUnauthorized();
    const agent = await this.prisma.printAgent.findUnique({
      where: { tokenHash: agentTokenHash(token) },
      select: {
        id: true,
        code: true,
        siteId: true,
        revokedAt: true,
        site: { select: { code: true } },
      },
    });
    if (!agent || agent.revokedAt) throw agentUnauthorized();
    req.ayvoAgent = {
      id: agent.id,
      code: agent.code,
      siteId: agent.siteId,
      siteCode: agent.site.code,
    };
    return true;
  }
}

/**
 * A print agent route: the access rule AND its token guard in one decorator, so neither can be
 * forgotten (the global guard allows the rule only under /api/agent/).
 */
export const PrintAgentAccess = () =>
  applyDecorators(
    SetMetadata(ACCESS_METADATA, { kind: 'agent' } satisfies AccessRule),
    UseGuards(PrintAgentGuard),
  );

export const CurrentAgent = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AgentPrincipal => {
    const agent = context.switchToHttp().getRequest<RequestWithAgent>().ayvoAgent;
    if (!agent) throw agentUnauthorized();
    return agent;
  },
);
