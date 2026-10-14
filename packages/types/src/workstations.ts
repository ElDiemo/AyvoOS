import { z } from 'zod';
import { catalogCodeSchema, productCategoryCodeSchema } from './catalog.js';
import { reasonSchema } from './identity.js';

/**
 * Workstations and work sessions (doc 026, issue #19 A2). A station is a work mode at one site
 * (labelling, or filling of one product category) with a printed QR. The QR identifies the
 * station only — never a login, permission or secret; the server re-validates everything on
 * every request.
 */

export const workstationModeSchema = z.enum(['LABELING', 'FILLING']);
export type WorkstationMode = z.infer<typeof workstationModeSchema>;
export const workstationStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
export const workstationCodeSchema = catalogCodeSchema;

const ref = z.object({ code: z.string(), name: z.string() });

export const workstationSchema = z.object({
  code: z.string(),
  name: z.string(),
  mode: workstationModeSchema,
  category: ref.nullable(),
  site: ref,
  warehouse: ref,
  status: workstationStatusSchema,
  createdAt: z.iso.datetime(),
});
export type Workstation = z.infer<typeof workstationSchema>;

/** Management view: also the URL encoded in the station's QR (not a secret). */
export const managedWorkstationSchema = workstationSchema.extend({
  qrUrl: z.string(),
  activeSession: z
    .object({ user: z.string(), lastActivityAt: z.iso.datetime(), leaseExpired: z.boolean() })
    .nullable(),
});
export type ManagedWorkstation = z.infer<typeof managedWorkstationSchema>;

export const createWorkstationRequestSchema = z
  .strictObject({
    requestId: z.uuid(),
    code: workstationCodeSchema,
    name: z.string().trim().min(1).max(200),
    mode: workstationModeSchema,
    categoryCode: productCategoryCodeSchema.nullable(),
    reason: reasonSchema,
  })
  .refine((r) => (r.mode === 'FILLING') === (r.categoryCode !== null), {
    message: 'A filling station needs a category; a labelling station has none',
    path: ['categoryCode'],
  });
export type CreateWorkstationRequest = z.infer<typeof createWorkstationRequestSchema>;

export const workstationStatusChangeRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
});
export type WorkstationStatusChangeRequest = z.infer<typeof workstationStatusChangeRequestSchema>;

export const stationSessionStatusSchema = z.enum(['ACTIVE', 'RELEASED', 'TAKEN_OVER', 'CLOSED']);

export const stationSessionSchema = z.object({
  id: z.uuid(),
  status: stationSessionStatusSchema,
  user: z.string(),
  openedAt: z.iso.datetime(),
  lastActivityAt: z.iso.datetime(),
  leaseExpiresAt: z.iso.datetime(),
});
export type StationSession = z.infer<typeof stationSessionSchema>;

/** POST /api/admin/station-sessions — scan of a station QR (opens or resumes). */
export const openStationSessionRequestSchema = z.strictObject({
  requestId: z.uuid(),
  scannedValue: z.string().min(1).max(2048),
});
export type OpenStationSessionRequest = z.infer<typeof openStationSessionRequestSchema>;

export const stationSessionResultSchema = z.object({
  outcome: z.enum(['OPENED', 'RESUMED', 'TAKEN_OVER']),
  session: stationSessionSchema,
  station: workstationSchema,
});
export type StationSessionResult = z.infer<typeof stationSessionResultSchema>;

/** GET /api/admin/station-sessions/current */
export const currentStationSessionSchema = z.object({
  current: z.object({ session: stationSessionSchema, station: workstationSchema }).nullable(),
  /** The user's last session, when someone else ended it (takeover, deactivation). */
  endedByOther: z
    .object({
      station: workstationSchema,
      status: stationSessionStatusSchema,
      endedBy: z.string(),
      endedAt: z.iso.datetime(),
      reason: z.string().nullable(),
    })
    .nullable(),
});
export type CurrentStationSession = z.infer<typeof currentStationSessionSchema>;

export const releaseStationSessionRequestSchema = z.strictObject({ requestId: z.uuid() });
export const takeoverStationSessionRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
});
export type TakeoverStationSessionRequest = z.infer<typeof takeoverStationSessionRequestSchema>;

/** Body of the 409 STATION_IN_USE refusal: who holds the station (for a handover or takeover). */
export const stationInUseSchema = z.object({
  sessionId: z.uuid(),
  holder: z.string(),
  lastActivityAt: z.iso.datetime(),
  leaseExpired: z.boolean(),
});
export type StationInUse = z.infer<typeof stationInUseSchema>;

export const publicWorkstationSchema = z.object({ kind: z.literal('AYVO_INTERNAL_MARK') });
