-- Owner decision 2026-10-21 (doc 031 §5): an order with at least one parcel picked up and not yet
-- delivered keeps its site active — also a partial pickup (the order still "Připravená k
-- vyzvednutí") and an order "Převzatá dopravcem" whose parcels are returning, lost, not delivered
-- or at a pick-up point (none of that is a delivery to the hotel). Every earlier blocker stays.
CREATE OR REPLACE FUNCTION sites_deactivation_dependencies() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."active" AND NOT NEW."active" AND (
       EXISTS (SELECT 1 FROM "hotels" h WHERE h."fulfillment_site_id" = NEW."id")
    OR EXISTS (SELECT 1 FROM "orders" o WHERE o."site_id" = NEW."id"
                                           AND o."status" IN ('OPEN', 'READY_TO_DISPATCH', 'READY_FOR_PICKUP'))
    OR EXISTS (SELECT 1 FROM "shipment_parcel_progress" pp
                 JOIN "shipments" s ON s."id" = pp."shipment_id"
                 JOIN "orders" o ON o."id" = s."order_id"
                WHERE o."site_id" = NEW."id" AND s."status" <> 'CANCELLED'
                  AND pp."picked_up_source" IS NOT NULL AND pp."delivered_at" IS NULL)) THEN
    RAISE EXCEPTION 'AYVO: a site serving hotels, holding unclosed orders or parcels in transit stays active'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
