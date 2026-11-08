import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { PortalGrantsController } from './portal-grants.controller.js';
import { PortalGrantsService } from './portal-grants.service.js';

/**
 * Hotel portal grants (ADR 0045 §4): the core's record of which payer and hotels a hotel portal
 * account may see. Finance's contract (finance-contract) issues and replaces them; the admin
 * route revokes them.
 */
@Module({
  imports: [IdentityModule],
  providers: [PortalGrantsService],
  controllers: [PortalGrantsController],
  exports: [PortalGrantsService],
})
export class PortalGrantsModule {}
