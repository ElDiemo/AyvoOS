import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

type Db = Prisma.TransactionClient;

export interface SalespersonRow {
  id: string;
  name: string;
}

/**
 * Who is a salesperson: an active user holding `sales:work` through an active role, evaluated
 * now. Exported for the commissions module (doc 068 §3.1), so it never reads identity tables for
 * this rule on its own.
 */
@Injectable()
export class SalespeopleService {
  /** The salesperson, or null when the user is not active or holds no `sales:work`. */
  async find(db: Db, userId: string): Promise<SalespersonRow | null> {
    const rows = await db.$queryRaw<SalespersonRow[]>`
      SELECT u."id", u."display_name" AS "name" FROM "users" u
      WHERE u."id" = ${userId}::uuid AND u."status" = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM "user_roles" ur
        JOIN "roles" r ON r."code" = ur."role_code" AND r."active"
        JOIN "role_permissions" rp ON rp."role_code" = r."code" AND rp."permission_code" = 'sales:work'
        WHERE ur."user_id" = u."id" AND ur."revoked_at" IS NULL)`;
    return rows[0] ?? null;
  }

  /** Every current salesperson, by name. */
  list(db: Db): Promise<SalespersonRow[]> {
    return db.$queryRaw<SalespersonRow[]>`
      SELECT u."id", u."display_name" AS "name" FROM "users" u
      WHERE u."status" = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM "user_roles" ur
        JOIN "roles" r ON r."code" = ur."role_code" AND r."active"
        JOIN "role_permissions" rp ON rp."role_code" = r."code" AND rp."permission_code" = 'sales:work'
        WHERE ur."user_id" = u."id" AND ur."revoked_at" IS NULL)
      ORDER BY u."display_name", u."id"`;
  }
}
