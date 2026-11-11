import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { PortalAccountsController } from './portal-accounts.controller.js';
import { PortalFencesService } from './portal-fences.service.js';
import { PortalGrantsController } from './portal-grants.controller.js';
import { PortalGrantsService } from './portal-grants.service.js';

/**
 * Hotel portal grants (ADR 0045 §4): the core's record of which payer and hotels a hotel portal
 * account may see. Finance's contract (finance-contract) issues and replaces them; the admin
 * route revokes them. Finance's contract also writes the operational fences and their resolutions
 * (v6, #148). The staff tab Hotely → Uživatelé lists the portal accounts with their grants.
 */
@Module({
  imports: [IdentityModule],
  providers: [PortalGrantsService, PortalFencesService],
  controllers: [PortalGrantsController, PortalAccountsController],
  exports: [PortalGrantsService, PortalFencesService],
})
export class PortalGrantsModule {}
