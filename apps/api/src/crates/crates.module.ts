import { Module } from '@nestjs/common';
import { CrateTypesService } from './crate-types.service.js';

/**
 * crates module (doc 020 §2): v0.1 holds only crate types (doc 023). Crates, crate labels and
 * crate cycles come with the production phases (doc 020 §14). Its routes are part of the
 * catalogue API (catalog module controller).
 */
@Module({
  providers: [CrateTypesService],
  exports: [CrateTypesService],
})
export class CratesModule {}
