-- Hotel portal, the operational boundary A2 (review 5858166766): a return to an image older than
-- the boundary must never bypass an effective fence. Such an image does not know `access`, the
-- fences or their resolutions: it reads every hotel of an active grant as operational.
--
-- Row-level security on "portal_grant_hotels" for the runtime role (the owner and the privileged
-- account are not subject to it). A connection of this image and later says so with the setting
-- `ayvo.portal_boundary = 'v6'` (PrismaService and PortalPrismaService, connection options) and
-- sees every row, as before: it applies the read rule itself (portal-fences.service.ts). Any other
-- connection — an older image — sees a grant's hotel only when it is OPERATIONS (an older image
-- does not know `access` and would open an invoices-only hotel too — e.g. of a payer whose change
-- was written before A2, with no fence; independent review of #180) and each fence of its payer ×
-- hotel still allows it by the same rule (today ≤ ends_on, or resolved and checked in the restore
-- revision or later) and its own end of operations has not passed. So after such a return a fenced
-- or invoices-only hotel is simply not part of the grant (no detail, profile, contracts or
-- deliveries; its invoices wait for the newer image again); every other hotel works as that image
-- knew it.
-- An older image cannot write a grant's hotel at all (no `access`; and the insert policy below).
--
-- The setting is a version marker, not a credential: the role, its password and the network stay
-- the security boundary, as before.

CREATE FUNCTION portal_grant_hotel_within_fences(
  p_grant_id UUID,
  p_hotel_id UUID,
  p_checked_revision INTEGER,
  p_operations_until DATE
) RETURNS BOOLEAN
  LANGUAGE sql
  STABLE
  AS $$
  SELECT (p_operations_until IS NULL OR (now() AT TIME ZONE 'Europe/Prague')::date <= p_operations_until)
    AND NOT EXISTS (
      SELECT 1
      FROM "portal_grants" g
      JOIN "portal_operational_fences" f
        ON f."payer_customer_id" = g."payer_customer_id" AND f."hotel_id" = p_hotel_id
      LEFT JOIN "portal_operational_fence_resolutions" r ON r."fence_id" = f."id"
      WHERE g."id" = p_grant_id
        AND (now() AT TIME ZONE 'Europe/Prague')::date > f."ends_on"
        AND (r."fence_id" IS NULL OR p_checked_revision IS NULL OR p_checked_revision < r."restore_revision")
    )
$$;

ALTER TABLE "portal_grant_hotels" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "portal_grant_hotels_read" ON "portal_grant_hotels" FOR SELECT USING (
  current_setting('ayvo.portal_boundary', true) = 'v6'
  OR ("access" = 'OPERATIONS'
      AND portal_grant_hotel_within_fences("grant_id", "hotel_id", "checked_revision", "operations_until"))
);

-- Grant hotels are never changed or deleted: such a statement reaches the history trigger, which
-- refuses it with its own answer (no row is hidden from it).
CREATE POLICY "portal_grant_hotels_change" ON "portal_grant_hotels" FOR UPDATE USING (true);
CREATE POLICY "portal_grant_hotels_delete" ON "portal_grant_hotels" FOR DELETE USING (true);

-- Only an image that knows the boundary writes a grant's hotels (with its access).
CREATE POLICY "portal_grant_hotels_write" ON "portal_grant_hotels" FOR INSERT WITH CHECK (
  current_setting('ayvo.portal_boundary', true) = 'v6'
);
