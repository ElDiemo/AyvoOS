import { Global, Module } from '@nestjs/common';
import { OperationRequestsService } from './operation-requests.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, OperationRequestsService],
  exports: [PrismaService, OperationRequestsService],
})
export class DatabaseModule {}
