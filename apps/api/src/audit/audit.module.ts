import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** The append-only security and administration audit (doc 021), shared by identity and sites. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
