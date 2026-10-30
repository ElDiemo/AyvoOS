import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  invoiceNumberSchema,
  retryInvoiceDeliverySchema,
  sendInvoiceSchema,
  type InvoiceDeliveries,
  type RetryInvoiceDeliveryRequest,
  type SendInvoiceRequest,
} from '@ayvo/types';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';
import { InvoiceDeliveriesService } from './invoice-deliveries.service.js';

const NUMBER = new ZodValidationPipe(invoiceNumberSchema);

/**
 * Sending an invoice's PDF by hand (doc 043): the state is readable with finance:invoices_read;
 * sending and retrying need finance:invoices_send, checked per request (ADMIN only).
 */
@Controller(`${ADMIN_PREFIX}/finance/invoices/:number/deliveries`)
export class InvoiceDeliveriesController {
  constructor(private readonly deliveries: InvoiceDeliveriesService) {}

  @Get()
  @RequirePermission('finance:invoices_read')
  list(@Param('number', NUMBER) number: string): Promise<InvoiceDeliveries> {
    return this.deliveries.list(number);
  }

  @Post()
  @RequirePermission('finance:invoices_send')
  send(
    @Param('number', NUMBER) number: string,
    @Body(new ZodValidationPipe(sendInvoiceSchema)) body: SendInvoiceRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<InvoiceDeliveries> {
    return this.deliveries.send(number, body, caller);
  }

  @Post(':id/retry')
  @RequirePermission('finance:invoices_send')
  retry(
    @Param('number', NUMBER) number: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(retryInvoiceDeliverySchema)) body: RetryInvoiceDeliveryRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<InvoiceDeliveries> {
    return this.deliveries.retry(number, id, body, caller);
  }
}
