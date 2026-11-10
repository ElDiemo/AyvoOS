import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { PortalAccountsController } from './portal-accounts.controller.js';
import { PortalGrantsController } from './portal-grants.controller.js';
import { PortalGrantsService } from './portal-grants.service.js';

/**
 * Hotel portal grants (ADR 0045 §4): the core's record of which payer and hotels a hotel portal
 * account may see. Finance's contract (finance-contract) issues and replaces them; the admin
 * route revokes them. The staff tab Hotely → Uživatelé lists the portal accounts with their grants.
 */
@Module({
  imports: [IdentityModule],
  providers: [PortalGrantsService],
  controllers: [PortalGrantsController, PortalAccountsController],
  exports: [PortalGrantsService],
})
export class PortalGrantsModule {}
