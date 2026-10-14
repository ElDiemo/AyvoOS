import { Global, Module } from '@nestjs/common';
import { OperationRequestsService } from './operation-requests.service.js';
import { PrismaService } from './prisma.service.js';
import { QrRegistryService } from './qr-registry.service.js';

@Global()
@Module({
  providers: [PrismaService, OperationRequestsService, QrRegistryService],
  exports: [PrismaService, OperationRequestsService, QrRegistryService],
})
export class DatabaseModule {}
