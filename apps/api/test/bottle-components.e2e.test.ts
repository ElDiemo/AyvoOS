import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { applyLabel, printedBottles, receiveBottles } from './support/warehouse-fixtures.js';

/**
 * Database-level guarantees of the bottle body ↔ label relationship (doc 018 §15): a QR identity
 * never moves to another body, label application cannot exist without its stock consumption,
 * component history is insert-only except one close.
 */
describe.skipIf(!hasDatabase)('bottle components (database invariants)', () => {
  let t: TestApp;
  let applied: { id: string; url: string; seriesCode: string };
  let fresh: { id: string; url: string; seriesCode: string };
  let other: { id: string; url: string; seriesCode: string };

  beforeAll(async () => {
    t = await createTestApp();
    const lot = (await receiveBottles(t, 3)).lines[0]!.lot!;
    const bottles = await printedBottles(t, 3);
    [applied, fresh, other] = [bottles[0]!, bottles[1]!, bottles[2]!];
    const res = await applyLabel(t, {
      lotId: lot.id,
      seriesCode: applied.seriesCode,
      scannedValue: applied.url,
    });
    expect(res.status).toBe(200);
  });
  afterAll(() => t?.close());

  const sql = (statement: string) => t.prisma.$executeRawUnsafe(statement);
  /**
   * Runs statements in one transaction, then evaluates the commit-time (deferred) checks against
   * the complete transaction with SET CONSTRAINTS ALL IMMEDIATE, then rolls back.
   */
  const inTransaction = (statements: string[]) =>
    t.prisma.$transaction(async (tx) => {
      for (const s of statements) await tx.$executeRawUnsafe(s);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw new Error('ROLLBACK_OK');
    });

  /** Context columns a new LABEL_APPLIED needs since doc 025 A3 (copied from a real one). */
  async function labelingColumns() {
    const e = await t.prisma.bottleEvent.findFirstOrThrow({
      where: { bottleId: applied.id, type: 'LABEL_APPLIED' },
    });
    return `'${e.crateCycleId}', '${e.workstationSessionId}', '${e.operationRequestId}', '${e.actorId}'`;
  }

  it('a label printed for another bottle can never be installed on this body', async () => {
    const item = await t.prisma.labelPrintJobItem.findFirstOrThrow({
      where: { bottleId: other.id },
    });
    await expect(
      inTransaction([
        `INSERT INTO bottle_events
           (id, bottle_id, type, occurred_at, crate_cycle_id, workstation_session_id, operation_request_id, actor_id)
           VALUES ('00000000-0000-4000-8000-00000000e001', '${fresh.id}', 'LABEL_APPLIED', now(),
                   ${await labelingColumns()})`,
        `INSERT INTO bottle_component_attachments
           (bottle_id, component_type, label_qr_url, print_job_id, print_job_position, installed_at, installed_event_id)
           VALUES ('${fresh.id}', 'LABEL', '${other.url}', '${item.printJobId}', ${item.position}, now(),
                   '00000000-0000-4000-8000-00000000e001')`,
      ]),
    ).rejects.toThrow(/printed for this bottle/);
  });

  it('LABEL_APPLIED without its stock consumption is refused', async () => {
    const item = await t.prisma.labelPrintJobItem.findFirstOrThrow({
      where: { bottleId: fresh.id },
    });
    await expect(
      inTransaction([
        `INSERT INTO bottle_events
           (id, bottle_id, type, occurred_at, crate_cycle_id, workstation_session_id, operation_request_id, actor_id)
           VALUES ('00000000-0000-4000-8000-00000000e002', '${fresh.id}', 'LABEL_APPLIED', now(),
                   ${await labelingColumns()})`,
        `UPDATE bottles SET status = 'LABELED_EMPTY' WHERE id = '${fresh.id}'`,
        `INSERT INTO bottle_component_attachments
           (bottle_id, component_type, label_qr_url, print_job_id, print_job_position, installed_at, installed_event_id)
           VALUES ('${fresh.id}', 'LABEL', '${fresh.url}', '${item.printJobId}', ${item.position}, now(),
                   '00000000-0000-4000-8000-00000000e002')`,
      ]),
    ).rejects.toThrow(/consume exactly one complete label-application BOM/);
  });

  it('no further stock consumption can be added to an already committed label application', async () => {
    // Regression (review of PR #3): the completeness check ran only when the event was inserted.
    const event = await t.prisma.bottleEvent.findFirstOrThrow({
      where: { bottleId: applied.id, type: 'LABEL_APPLIED' },
    });
    // A label application also consumes components without lot tracking (lot NULL): pick one
    // movement deterministically and write its lot as SQL NULL, never the string 'null'.
    const movement = await t.prisma.inventoryMovement.findFirstOrThrow({
      where: { bottleEventId: event.id },
      orderBy: { id: 'asc' },
    });
    const lot = movement.lotId === null ? 'NULL' : `'${movement.lotId}'`;
    await expect(
      inTransaction([
        `INSERT INTO bom_versions (id, code, version, stage, valid_from)
           VALUES ('00000000-0000-4000-8000-00000000b002', 'LABEL_APPLICATION', 99, 'LABEL_APPLICATION', now())`,
        `INSERT INTO bom_lines (id, bom_version_id, line_no, item_id, unit_id, quantity)
           VALUES ('00000000-0000-4000-8000-00000000b003', '00000000-0000-4000-8000-00000000b002', 1,
                   '${movement.itemId}', '${movement.unitId}', 1)`,
        `INSERT INTO inventory_movements
           (item_id, unit_id, location_id, lot_id, quantity_delta, type, bottle_event_id, bom_line_id, occurred_at)
           VALUES ('${movement.itemId}', '${movement.unitId}', '${movement.locationId}', ${lot}, -1,
                   'LABEL_APPLICATION', '${event.id}', '00000000-0000-4000-8000-00000000b003', now())`,
      ]),
    ).rejects.toThrow(/consume exactly one complete label-application BOM/);
  });

  it('status never goes back; tokens never move', async () => {
    await expect(
      sql(`UPDATE bottles SET status = 'CREATED' WHERE id = '${applied.id}'`),
    ).rejects.toThrow(/LABELED_EMPTY → CREATED is not allowed/);
    const token = other.url.split('/').pop()!;
    await expect(
      sql(`UPDATE bottles SET public_token = '${token}' WHERE id = '${applied.id}'`),
    ).rejects.toThrow(/identity columns are immutable/);
  });

  it('component history: one open label per bottle; closed exactly once; never deleted', async () => {
    const open = await t.prisma.bottleComponentAttachment.findFirstOrThrow({
      where: { bottleId: applied.id },
    });
    await expect(
      sql(`UPDATE bottle_component_attachments SET label_qr_url = 'x' WHERE id = '${open.id}'`),
    ).rejects.toThrow(/closed once/);
    await expect(
      sql(`DELETE FROM bottle_component_attachments WHERE id = '${open.id}'`),
    ).rejects.toThrow();
    // Closing (future replacement workflow) is allowed once, with reason and disposition.
    await expect(
      inTransaction([
        `UPDATE bottle_component_attachments SET removed_at = now(), removal_reason = 'damaged label',
           disposition = 'SCRAPPED' WHERE id = '${open.id}'`,
        `UPDATE bottle_component_attachments SET removal_reason = 'other' WHERE id = '${open.id}'`,
      ]),
    ).rejects.toThrow(/closed once/);
    await expect(
      inTransaction([
        `UPDATE bottle_component_attachments SET removed_at = now(), removal_reason = 'damaged label',
           disposition = 'SCRAPPED' WHERE id = '${open.id}'`,
      ]),
    ).rejects.toThrow(/ROLLBACK_OK/);
  });
});
