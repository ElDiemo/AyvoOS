import { z } from 'zod';
import { reasonSchema } from './identity.js';

/**
 * Obchod — hotel acquisition (doc 034, ADR 0031). A prospect is not an operational hotel; nothing
 * here creates anything outside Obchod. Visibility is by ownership (`sales:work`) or everything
 * (`sales:manage`), evaluated by the API on every read and write.
 */

/** Every sales date ("today", overdue, activity times) is evaluated in this zone (doc 034 §6). */
export const SALES_TIME_ZONE = 'Europe/Prague';

export const prospectCodeSchema = z.string().regex(/^AKV-\d{6,}$/, 'e.g. AKV-000001');

export const PROSPECT_STAGES = ['NEW', 'CONTACTED', 'NEGOTIATION', 'OFFER', 'WON', 'LOST'] as const;
export const prospectStageSchema = z.enum(PROSPECT_STAGES);
export type ProspectStage = z.infer<typeof prospectStageSchema>;
/** Work in progress (the overview's "rozpracovaní"). */
export const IN_PROGRESS_STAGES: readonly ProspectStage[] = ['CONTACTED', 'NEGOTIATION', 'OFFER'];
/** The order of the pipeline: a lower rank than the current stage is a step back. */
export function stageRank(stage: ProspectStage): number {
  return stage === 'LOST' ? 4 : PROSPECT_STAGES.indexOf(stage);
}
/** A change that needs a reason: back in the pipeline, or out of a result (reopening). */
export function stageChangeNeedsReason(from: ProspectStage, to: ProspectStage): boolean {
  if (from === to) return false;
  if (from === 'WON' || from === 'LOST') return true;
  return to !== 'LOST' && stageRank(to) < stageRank(from);
}

export const prioritySchema = z.enum(['A', 'B', 'C']);
export type Priority = z.infer<typeof prioritySchema>;

export const accommodationTypeSchema = z.enum([
  'HOTEL',
  'PENSION',
  'APARTMENTS',
  'HOSTEL',
  'OTHER',
]);
export type AccommodationType = z.infer<typeof accommodationTypeSchema>;

export const ACTIVITY_KINDS = [
  'CALL',
  'EMAIL_SENT',
  'EMAIL_RECEIVED',
  'MEETING',
  'SAMPLES',
  'OFFER',
  'NOTE',
] as const;
export const activityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof activityKindSchema>;
/** Kinds that mean the hotel was in contact (first / last contact); a note is not one. */
export const CONTACT_ACTIVITY_KINDS: readonly ActivityKind[] = [
  'CALL',
  'EMAIL_SENT',
  'EMAIL_RECEIVED',
  'MEETING',
  'SAMPLES',
  'OFFER',
];

export const taskStatusSchema = z.enum(['OPEN', 'DONE', 'CANCELLED']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Optional text: trimmed, empty → null. */
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));
const required = (max: number) => z.string().trim().min(1).max(max);

/** A calendar day (YYYY-MM-DD) in the sales time zone. */
export const salesDateSchema = z.iso.date();
/** A wall-clock time in the sales time zone (YYYY-MM-DDTHH:mm), converted by the server. */
export const salesLocalTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:mm');

export const phoneSchema = z
  .string()
  .trim()
  .max(40)
  .regex(/^\+?[0-9 ()./-]{3,40}$/, 'Phone number')
  .nullable()
  .or(z.literal('').transform(() => null));

const contactFields = {
  /** A person's name or a designation such as "Recepce" — never an invented person. */
  label: required(160),
  position: optional(120),
  email: z
    .email()
    .max(254)
    .nullable()
    .or(z.literal('').transform(() => null)),
  phone: phoneSchema,
  note: optional(1000),
  isPrimary: z.boolean(),
};

const profileFields = {
  name: required(200),
  countryCode: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2'),
  city: optional(120),
  addressLine1: optional(200),
  addressLine2: optional(200),
  postalCode: optional(20),
  /** An estimate; null = unknown (never 0). */
  roomsEstimate: z.number().int().min(1).max(100000).nullable(),
  accommodationType: accommodationTypeSchema.nullable(),
  website: optional(300),
  source: optional(200),
  priority: prioritySchema.nullable(),
  note: optional(4000),
};

export const createProspectRequestSchema = z.strictObject({
  requestId: z.uuid(),
  ...profileFields,
  /** Only with `sales:manage`; otherwise the creator owns the prospect. */
  ownerId: z.uuid().nullable(),
  /** An optional first contact. */
  contact: z.strictObject(contactFields).nullable(),
  /** "Přesto založit" after a possible-duplicate warning. */
  acknowledgeDuplicates: z.boolean(),
});
export type CreateProspectRequest = z.infer<typeof createProspectRequestSchema>;

export const updateProspectRequestSchema = z.strictObject({
  requestId: z.uuid(),
  /** The revision the edit is based on; a newer one is refused (never overwritten). */
  revision: z.number().int().min(1),
  ...profileFields,
});
export type UpdateProspectRequest = z.infer<typeof updateProspectRequestSchema>;

export const changeStageRequestSchema = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().min(1),
  stage: prospectStageSchema,
  /** Required when moving back or reopening a result (doc 034 §4). */
  reason: reasonSchema.nullable(),
  /** Required exactly for LOST. */
  lostReason: z.string().trim().min(3).max(500).nullable(),
});
export type ChangeStageRequest = z.infer<typeof changeStageRequestSchema>;

export const changeOwnerRequestSchema = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().min(1),
  ownerId: z.uuid(),
  reason: reasonSchema.nullable(),
});
export type ChangeOwnerRequest = z.infer<typeof changeOwnerRequestSchema>;

export const saveContactRequestSchema = z.strictObject({
  requestId: z.uuid(),
  /** null = a new contact; else the revision the edit is based on. */
  revision: z.number().int().min(1).nullable(),
  ...contactFields,
});
export type SaveContactRequest = z.infer<typeof saveContactRequestSchema>;

export const retireContactRequestSchema = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().min(1),
  reason: reasonSchema,
});
export type RetireContactRequest = z.infer<typeof retireContactRequestSchema>;

const followUpSchema = z.strictObject({
  title: required(200),
  dueOn: salesDateSchema,
  contactId: z.uuid().nullable(),
});

export const recordActivityRequestSchema = z.strictObject({
  requestId: z.uuid(),
  kind: activityKindSchema,
  /** When it really happened, in the sales time zone (e.g. yesterday's call). */
  occurredAt: salesLocalTimeSchema,
  contactId: z.uuid().nullable(),
  content: required(4000),
  outcome: optional(1000),
  /** An optional next task created together with the activity (never required). */
  followUp: followUpSchema.nullable(),
});
export type RecordActivityRequest = z.infer<typeof recordActivityRequestSchema>;

export const correctActivityRequestSchema = z.discriminatedUnion('withdraw', [
  z.strictObject({
    requestId: z.uuid(),
    withdraw: z.literal(false),
    kind: activityKindSchema,
    occurredAt: salesLocalTimeSchema,
    contactId: z.uuid().nullable(),
    content: required(4000),
    outcome: optional(1000),
    reason: reasonSchema,
  }),
  /** "Zapsáno omylem": the activity stays visible as withdrawn, with the reason. */
  z.strictObject({ requestId: z.uuid(), withdraw: z.literal(true), reason: reasonSchema }),
]);
export type CorrectActivityRequest = z.infer<typeof correctActivityRequestSchema>;

export const createTaskRequestSchema = z.strictObject({
  requestId: z.uuid(),
  title: required(200),
  dueOn: salesDateSchema,
  contactId: z.uuid().nullable(),
  /** null = the prospect's owner; another person only with `sales:manage`. */
  assigneeId: z.uuid().nullable(),
  note: optional(2000),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().min(1),
  title: required(200),
  contactId: z.uuid().nullable(),
  assigneeId: z.uuid(),
  note: optional(2000),
});
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export const rescheduleTaskRequestSchema = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().min(1),
  dueOn: salesDateSchema,
  reason: optional(500),
});
export type RescheduleTaskRequest = z.infer<typeof rescheduleTaskRequestSchema>;

export const completeTaskRequestSchema = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().min(1),
  result: optional(1000),
});
export type CompleteTaskRequest = z.infer<typeof completeTaskRequestSchema>;

export const cancelTaskRequestSchema = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().min(1),
  reason: reasonSchema,
});
export type CancelTaskRequest = z.infer<typeof cancelTaskRequestSchema>;

// --- queries -------------------------------------------------------------------------------------

export const PROSPECT_PAGE_SIZE = 25;
export const nextTaskFilterSchema = z.enum(['overdue', 'today', 'week', 'none']);
export type NextTaskFilter = z.infer<typeof nextTaskFilterSchema>;

export const prospectListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  /** "me", a user id (sales:manage) — default: me without sales:manage, everyone with it. */
  owner: z.union([z.literal('me'), z.uuid()]).optional(),
  stage: prospectStageSchema.optional(),
  priority: prioritySchema.optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  next: nextTaskFilterSchema.optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
export type ProspectListQuery = z.infer<typeof prospectListQuerySchema>;

export const taskListQuerySchema = z.object({
  /** "me" (default), "all" or a user id — anything but "me" needs sales:manage. */
  assignee: z.union([z.literal('me'), z.literal('all'), z.uuid()]).default('me'),
  status: z.enum(['OPEN', 'CLOSED']).default('OPEN'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const duplicateQuerySchema = z.object({
  name: z.string().trim().max(200).optional(),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  website: z.string().trim().max(300).optional(),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  /** The prospect itself (detail page). */
  exclude: prospectCodeSchema.optional(),
});
export type DuplicateQuery = z.infer<typeof duplicateQuerySchema>;

// --- views ---------------------------------------------------------------------------------------

export const userRefSchema = z.object({ id: z.uuid(), name: z.string() });
export type UserRef = z.infer<typeof userRefSchema>;

export const taskSchema = z.object({
  id: z.uuid(),
  prospect: z.object({ code: z.string(), name: z.string() }),
  title: z.string(),
  note: z.string().nullable(),
  dueOn: salesDateSchema,
  status: taskStatusSchema,
  result: z.string().nullable(),
  assignee: userRefSchema,
  contact: z.object({ id: z.uuid(), label: z.string() }).nullable(),
  revision: z.number().int(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  closedAt: z.iso.datetime().nullable(),
  closedBy: z.string().nullable(),
});
export type SalesTask = z.infer<typeof taskSchema>;

export const prospectSummarySchema = z.object({
  code: z.string(),
  name: z.string(),
  countryCode: z.string(),
  city: z.string().nullable(),
  stage: prospectStageSchema,
  priority: prioritySchema.nullable(),
  roomsEstimate: z.number().int().nullable(),
  owner: userRefSchema,
  lastContactAt: z.iso.datetime().nullable(),
  nextTask: z
    .object({ id: z.uuid(), title: z.string(), dueOn: salesDateSchema, assignee: z.string() })
    .nullable(),
  openTasks: z.number().int(),
});
export type ProspectSummary = z.infer<typeof prospectSummarySchema>;

export const prospectPageSchema = z.object({
  items: z.array(prospectSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Today in the sales time zone (for "dnes" / "po termínu"). */
  today: salesDateSchema,
});
export type ProspectPage = z.infer<typeof prospectPageSchema>;

export const contactSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  position: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  note: z.string().nullable(),
  isPrimary: z.boolean(),
  revision: z.number().int(),
  retired: z.object({ at: z.iso.datetime(), by: z.string(), reason: z.string() }).nullable(),
});
export type SalesContact = z.infer<typeof contactSchema>;

const activityVersionSchema = z.object({
  id: z.uuid(),
  kind: activityKindSchema,
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  author: z.string(),
  contact: z.object({ id: z.uuid(), label: z.string() }).nullable(),
  content: z.string().nullable(),
  outcome: z.string().nullable(),
  withdrawn: z.boolean(),
  /** The reason of this version when it corrects an earlier one. */
  correctionReason: z.string().nullable(),
});
export const activitySchema = activityVersionSchema.extend({
  /** Earlier versions of this activity, oldest first (empty: never corrected). */
  earlier: z.array(activityVersionSchema),
});
export type SalesActivity = z.infer<typeof activitySchema>;

export const salesEventTypeSchema = z.enum([
  'PROSPECT_CREATED',
  'PROSPECT_UPDATED',
  'STAGE_CHANGED',
  'OWNER_CHANGED',
  'CONTACT_ADDED',
  'CONTACT_UPDATED',
  'CONTACT_RETIRED',
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_RESCHEDULED',
  'TASK_DONE',
  'TASK_CANCELLED',
]);
export type SalesEventType = z.infer<typeof salesEventTypeSchema>;

export const salesEventSchema = z.object({
  id: z.uuid(),
  type: salesEventTypeSchema,
  occurredAt: z.iso.datetime(),
  actor: z.string(),
  /** Type-specific: before/after values, reasons, task title — rendered by the UI per type. */
  payload: z.record(z.string(), z.unknown()),
});
export type SalesEvent = z.infer<typeof salesEventSchema>;

export const duplicateHintSchema = z.object({
  /**
   * Possible duplicates among the prospects the user may open (all for sales:manage). Another
   * salesperson's prospects are never matched, not even as a count (doc 034 §8).
   */
  accessible: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      city: z.string().nullable(),
      owner: z.string(),
      reasons: z.array(z.enum(['NAME', 'WEBSITE', 'EMAIL', 'PHONE'])),
    }),
  ),
});
export type DuplicateHint = z.infer<typeof duplicateHintSchema>;

export const prospectDetailSchema = z.object({
  code: z.string(),
  name: z.string(),
  countryCode: z.string(),
  city: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  postalCode: z.string().nullable(),
  roomsEstimate: z.number().int().nullable(),
  accommodationType: accommodationTypeSchema.nullable(),
  website: z.string().nullable(),
  source: z.string().nullable(),
  priority: prioritySchema.nullable(),
  stage: prospectStageSchema,
  lostReason: z.string().nullable(),
  note: z.string().nullable(),
  owner: userRefSchema,
  revision: z.number().int(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  firstContactAt: z.iso.datetime().nullable(),
  lastContactAt: z.iso.datetime().nullable(),
  contacts: z.array(contactSchema),
  openTasks: z.array(taskSchema),
  closedTasks: z.array(taskSchema),
  /** Current versions, newest event first. */
  activities: z.array(activitySchema),
  /** Every change, newest first. */
  events: z.array(salesEventSchema),
  duplicates: duplicateHintSchema,
  today: salesDateSchema,
});
export type ProspectDetail = z.infer<typeof prospectDetailSchema>;

export const taskPageSchema = z.object({
  items: z.array(taskSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  today: salesDateSchema,
});
export type TaskPage = z.infer<typeof taskPageSchema>;

export const salesOverviewSchema = z.object({
  today: salesDateSchema,
  scope: z.enum(['me', 'all']),
  overdue: z.array(taskSchema),
  dueToday: z.array(taskSchema),
  /** The next 7 days after today. */
  upcoming: z.array(taskSchema),
  inProgress: z.array(prospectSummarySchema),
  counts: z.object({
    overdue: z.number().int(),
    dueToday: z.number().int(),
    upcoming: z.number().int(),
    inProgress: z.number().int(),
    /** Prospects in progress without any open task (nobody knows the next step). */
    withoutNextStep: z.number().int(),
  }),
});
export type SalesOverview = z.infer<typeof salesOverviewSchema>;

export const salespersonSchema = z.object({ id: z.uuid(), name: z.string(), email: z.string() });
export type Salesperson = z.infer<typeof salespersonSchema>;
