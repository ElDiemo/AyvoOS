import { z } from 'zod';
import { reasonSchema } from './identity.js';

/**
 * Printers and print agents of a site (doc 030 §3, ADR 0028) and the print agent's own API.
 * A print agent is a machine (Raspberry Pi) with its own identity; its token is shown once and
 * stored only as a hash. Only the Zebra ZD220 DT (native ZPL, 203 dpi, USB) is supported.
 */

const op = { requestId: z.uuid() };
const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, 'Velká písmena, číslice a pomlčky (2–32 znaků)');
const nameSchema = z.string().trim().min(1).max(100);

export const PRINTER_MODELS = ['ZEBRA_ZD220_DT'] as const;
export const printerModelSchema = z.enum(PRINTER_MODELS);
/** What the only supported model is (never assumed for another one). */
export const PRINTER_MODEL_SPEC = {
  ZEBRA_ZD220_DT: { name: 'Zebra ZD220 DT', language: 'ZPL', dpi: 203, connection: 'USB' },
} as const;

export const detectedDeviceSchema = z.strictObject({
  usbSerial: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  product: z.string().max(100).nullable(),
  manufacturer: z.string().max(100).nullable(),
});
export type DetectedDevice = z.infer<typeof detectedDeviceSchema>;

export const printAgentSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  /** The token's last 4 characters, to recognise it (never the token). */
  tokenHint: z.string(),
  tokenIssuedAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  lastVersion: z.string().nullable(),
  /** Contacted the server within the last 2 minutes. */
  online: z.boolean(),
  /** USB printers the agent reported with its last contact (never selected by themselves). */
  detectedDevices: z.array(detectedDeviceSchema),
  detectedAt: z.iso.datetime().nullable(),
});
export type PrintAgent = z.infer<typeof printAgentSchema>;

export const printerSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  model: printerModelSchema,
  dpi: z.number().int(),
  agent: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  usbSerial: z.string(),
  dispatchDefault: z.boolean(),
  autoPrint: z.boolean(),
  enabled: z.boolean(),
  reportedState: z.enum(['READY', 'NOT_FOUND', 'ERROR']).nullable(),
  reportedDetail: z.string().nullable(),
  reportedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string(),
});
export type Printer = z.infer<typeof printerSchema>;

export const sitePrintingSchema = z.object({
  site: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  agents: z.array(printAgentSchema),
  printers: z.array(printerSchema),
});
export type SitePrinting = z.infer<typeof sitePrintingSchema>;

export const createPrintAgentRequestSchema = z.strictObject({
  ...op,
  code: codeSchema,
  name: nameSchema,
});
export type CreatePrintAgentRequest = z.infer<typeof createPrintAgentRequestSchema>;
export const rotatePrintAgentRequestSchema = z.strictObject({ ...op, reason: reasonSchema });
export type RotatePrintAgentRequest = z.infer<typeof rotatePrintAgentRequestSchema>;
export const revokePrintAgentRequestSchema = z.strictObject({ ...op, reason: reasonSchema });
export type RevokePrintAgentRequest = z.infer<typeof revokePrintAgentRequestSchema>;

/**
 * The answer to creating or rotating an agent: the ONLY time the token is shown. A replay of the
 * same request (a lost answer) gets null — the token is never stored; rotate it again instead.
 */
export const printAgentTokenSchema = z.object({
  agent: printAgentSchema,
  token: z.string().nullable(),
});
export type PrintAgentToken = z.infer<typeof printAgentTokenSchema>;

export const savePrinterRequestSchema = z.strictObject({
  ...op,
  /** null = a new printer. */
  id: z.uuid().nullable(),
  code: codeSchema,
  name: nameSchema,
  model: printerModelSchema,
  agentId: z.uuid(),
  usbSerial: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, 'Sériové číslo USB (písmena, číslice, . _ -)'),
  dispatchDefault: z.boolean(),
  autoPrint: z.boolean(),
  enabled: z.boolean(),
});
export type SavePrinterRequest = z.infer<typeof savePrinterRequestSchema>;

// --- the print agent's API (/api/agent/v1, header X-Ayvo-Print-Agent) -------------------------

export const agentHeartbeatRequestSchema = z.strictObject({
  version: z.string().trim().min(1).max(40),
  /** The USB printers this agent sees now (doc 030 §3) — a suggestion for the ADMIN only. */
  devices: z.array(detectedDeviceSchema).max(10).optional(),
  printers: z
    .array(
      z.strictObject({
        printerId: z.uuid(),
        state: z.enum(['READY', 'NOT_FOUND', 'ERROR']),
        detail: z.string().max(300).nullable(),
      }),
    )
    .max(20),
});
export type AgentHeartbeatRequest = z.infer<typeof agentHeartbeatRequestSchema>;

export const agentPrinterSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  usbSerial: z.string(),
  enabled: z.boolean(),
});
export const agentHeartbeatSchema = z.object({
  agent: z.object({ code: z.string(), site: z.string() }),
  printers: z.array(agentPrinterSchema),
});
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;

export const agentClaimRequestSchema = z.strictObject({});
export const agentJobSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  printerId: z.uuid(),
  usbSerial: z.string(),
  claimToken: z.string(),
  leaseUntil: z.iso.datetime(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
});
export type AgentJob = z.infer<typeof agentJobSchema>;
export const agentClaimSchema = z.object({ job: agentJobSchema.nullable() });
export type AgentClaim = z.infer<typeof agentClaimSchema>;

export const agentStartRequestSchema = z.strictObject({ claimToken: z.string().min(32).max(64) });
export type AgentStartRequest = z.infer<typeof agentStartRequestSchema>;

export const agentResultRequestSchema = z.strictObject({
  claimToken: z.string().min(32).max(64),
  /**
   * SENT = every byte written to the device; FAILED_BEFORE_SEND = nothing was written (the device
   * was never opened for writing); UNCERTAIN = the write may have happened.
   */
  outcome: z.enum(['SENT', 'FAILED_BEFORE_SEND', 'UNCERTAIN']),
  detail: z.string().max(500).nullable(),
});
export type AgentResultRequest = z.infer<typeof agentResultRequestSchema>;

export const agentJobStateSchema = z.object({
  id: z.uuid(),
  status: z.enum(['QUEUED', 'CLAIMED', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'CANCELLED']),
});
export type AgentJobState = z.infer<typeof agentJobStateSchema>;
