import type {
  SalesIndicativePrice,
  SalesIndicativePrices,
  SetIndicativePriceRequest,
} from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';

type Row = {
  id: string;
  currency: string;
  amount: { toFixed: (n: number) => string };
  note: string;
  setAt: Date;
  setter: { displayName: string };
};
const view = (r: Row): SalesIndicativePrice => ({
  id: r.id,
  currency: r.currency,
  amount: r.amount.toFixed(2),
  note: r.note,
  setBy: r.setter.displayName,
  setAt: r.setAt.toISOString(),
});

/**
 * The indicative price of Obchod (doc 060 §D): the sales manager sets it (append-only versions, the
 * newest per currency is current); every salesperson reads it for the calculator. Nothing of
 * Finance is read or written: this is a number to talk about, never an offer or a price list.
 */
@Injectable()
export class SalesPricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
  ) {}

  async list(): Promise<SalesIndicativePrices> {
    const history = await this.prisma.salesIndicativePrice.findMany({
      orderBy: [{ setAt: 'desc' }, { id: 'desc' }],
      take: 20,
      include: { setter: { select: { displayName: true } } },
    });
    const currencies = await this.prisma.salesIndicativePrice.findMany({
      distinct: ['currency'],
      orderBy: [{ currency: 'asc' }, { setAt: 'desc' }, { id: 'desc' }],
      include: { setter: { select: { displayName: true } } },
    });
    return { current: currencies.map(view), history: history.map(view) };
  }

  async set(actorId: string, input: SetIndicativePriceRequest): Promise<SalesIndicativePrices> {
    await this.operations.run(
      'SALES_INDICATIVE_PRICE_SET',
      input.requestId,
      { actorId, ...input, requestId: undefined },
      async (tx) => {
        const row = await tx.salesIndicativePrice.create({
          data: {
            currency: input.currency,
            amount: input.amount,
            note: input.note,
            setBy: actorId,
            requestId: input.requestId,
          },
        });
        return { id: row.id };
      },
    );
    return this.list();
  }
}
