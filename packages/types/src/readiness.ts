import { z } from 'zod';

/**
 * "Připravit výrobu" (doc 027 §4): a read-only overview for the active site and one product —
 * the permanent setup, what labelling needs, what filling needs, and the real crate states. It
 * permits and blocks nothing (the server decides every scan on its own) and reserves nothing.
 *
 * Every item is computed only with the existing permission the user would need for its page;
 * otherwise it is UNAVAILABLE with no count — never 0 and never OK.
 */
export const readinessStateSchema = z.enum(['OK', 'MISSING', 'UNAVAILABLE']);
export type ReadinessState = z.infer<typeof readinessStateSchema>;

export const readinessItemSchema = z.object({
  /** Stable key, e.g. "labeling.station" (texts are the client's). */
  key: z.string(),
  state: readinessStateSchema,
  /** A count when the user may see it (pieces, bottles' worth, crates, stations); else null. */
  count: z.number().int().nullable(),
  /** The existing page where it is set up or seen, when the user may open it. */
  href: z.string().nullable(),
  /**
   * Why an UNAVAILABLE item could not be judged: the user lacks its permission, or the site has
   * no warehouse yet (then stock is unknown — never reported as 0). Null otherwise.
   */
  reason: z.enum(['PERMISSION', 'NO_WAREHOUSE']).nullable(),
  /**
   * The recipe version a filling material was judged against: the versions pinned on the crates
   * waiting for filling (`waitingCrates` > 0), or — with no such crate — the product's active
   * version as the plan for new crates (`waitingCrates` null). Null for other items.
   */
  recipe: z
    .object({ version: z.number().int(), waitingCrates: z.number().int().nullable() })
    .nullable(),
  /**
   * What the next step needs to keep its context (issue #11 UI-21): the stock item of the judged
   * recipe line, the approved designs of the product usable for new QR identities (latest
   * version of an active template), the station mode and category. Null when not applicable or
   * not available to the user.
   */
  target: z
    .object({
      item: z.object({ code: z.string(), name: z.string() }).nullable(),
      designs: z.array(z.object({ versionId: z.uuid(), label: z.string() })),
      station: z
        .object({
          mode: z.enum(['LABELING', 'FILLING']),
          categoryCode: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
});
export type ReadinessItem = z.infer<typeof readinessItemSchema>;

export const productionReadinessSchema = z.object({
  site: z.object({ code: z.string(), name: z.string() }),
  /** Active products to choose from (catalog:read), else empty. */
  products: z.array(z.object({ code: z.string(), name: z.string() })),
  product: z.object({ code: z.string(), name: z.string(), category: z.string() }).nullable(),
  setup: z.array(readinessItemSchema),
  labeling: z.array(readinessItemSchema),
  filling: z.array(readinessItemSchema),
  /** Crates of the product per state (crates:read), or null when unavailable. */
  crates: z
    .object({
      openAssembly: z.number().int(),
      readyToFill: z.number().int(),
      filling: z.number().int(),
      filled: z.number().int(),
    })
    .nullable(),
});
export type ProductionReadiness = z.infer<typeof productionReadinessSchema>;

export const productionReadinessQuerySchema = z.object({
  product: z.string().trim().min(1).max(40).optional(),
});
export type ProductionReadinessQuery = z.infer<typeof productionReadinessQuerySchema>;
