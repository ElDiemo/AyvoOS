import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createExchangeLog,
  redact,
  REDACTED,
  REDACTED_PERSONAL,
} from './support/ppl-exchange-log.js';

const CLIENT_ID = 'client-id-for-the-test';
const SECRET = 'very-secret-value-0123';
const TOKEN = 'eyJ.token-value.of-the-run';
const BASE = 'https://api-dev.dhl.com/ecs/ppl/myapi2';

/** A carrier that answers like PPL: a token, a batch (201 + Location), a label (PDF). */
const carrier = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith('/login/getAccessToken')) {
    return Response.json({ access_token: TOKEN, expires_in: 1800 });
  }
  if (path.endsWith('/shipment/batch') && init?.method === 'POST') {
    return new Response(null, { status: 201, headers: { Location: `${BASE}/shipment/batch/b-1` } });
  }
  if (path.includes('/data/')) {
    return new Response(Buffer.from('%PDF-1.4 label'), {
      headers: { 'content-type': 'application/pdf' },
    });
  }
  // A carrier that echoes the token or a credential must not get it into the evidence.
  return Response.json({ echo: `Bearer ${TOKEN}`, note: `id ${CLIENT_ID}` });
}) as typeof fetch;

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-exchanges-'));
  const log = createExchangeLog(dir, [CLIENT_ID, SECRET], 'run');
  return { log, fetch: log.wrap(carrier), lines: () => readFileSync(log.file, 'utf8') };
}

const batch = {
  shipments: [
    {
      referenceId: 'SHP-000002-1',
      recipient: { name: 'Hotel', phone: '+420 581 000 000', email: 'recepce@example.com' },
      externalNumbers: [{ code: 'CUST', externalNumber: 'SHP-000002-1' }],
      shipmentSet: {
        numberOfShipments: 2,
        shipmentSetItems: [
          { externalNumbers: [{ code: 'CUST', externalNumber: 'SHP-000002-1-1' }] },
          { externalNumbers: [{ code: 'CUST', externalNumber: 'SHP-000002-1-2' }] },
        ],
      },
    },
  ],
};

describe('live run exchange log (evidence outside git)', () => {
  it('keeps the exact body sent and the answer, in order, without secrets or contacts', async () => {
    const r = run();
    await r.fetch(`${BASE}/login/getAccessToken`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: SECRET }),
    });
    const body = JSON.stringify(batch);
    await r.fetch(`${BASE}/shipment/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    await r.fetch(`${BASE}/shipment?ShipmentNumbers=1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    await r.fetch(`${BASE}/data/abc`, { headers: { Authorization: `Bearer ${TOKEN}` } });

    const text = r.lines();
    for (const s of [CLIENT_ID, SECRET, TOKEN, '+420 581', 'recepce@example.com']) {
      expect(text).not.toContain(s);
    }
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => `${l.seq}${l.phase}`)).toEqual([
      '1sent',
      '1received',
      '2sent',
      '2received',
      '3sent',
      '3received',
      '4sent',
      '4received',
    ]);
    expect(lines[0].body).toBe('[token request – not recorded]');
    expect(lines[1].body).toBe('[token response – not recorded]');
    const sent = lines[2].body.json.shipments[0];
    // References, set and item order exactly as sent.
    expect(sent.referenceId).toBe('SHP-000002-1');
    expect(sent.externalNumbers).toEqual(batch.shipments[0]!.externalNumbers);
    expect(sent.shipmentSet).toEqual(batch.shipments[0]!.shipmentSet);
    expect(sent.recipient).toEqual({
      name: 'Hotel',
      phone: REDACTED_PERSONAL,
      email: REDACTED_PERSONAL,
    });
    expect(lines[2].body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[3]).toMatchObject({
      status: 201,
      headers: { location: `${BASE}/shipment/batch/b-1` },
    });
    expect(lines[5].body.json).toEqual({ echo: `Bearer ${REDACTED}`, note: `id ${REDACTED}` });
    expect(lines[7].body).toMatchObject({
      bytes: 14,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(statSync(r.log.file).mode & 0o777).toBe(0o600);
  });

  it('records a request whose answer never came', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ayvo-exchanges-'));
    const log = createExchangeLog(dir, [SECRET], 'lost');
    const lost = log.wrap((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    await expect(
      lost(`${BASE}/shipment/batch`, { method: 'POST', body: '{"a":1}' }),
    ).rejects.toThrow();
    const lines = readFileSync(log.file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.phase)).toEqual(['sent', 'failed']);
    expect(lines[0].body.json).toEqual({ a: 1 });
  });

  it('refuses a directory inside a git worktree', () => {
    expect(() => createExchangeLog(process.cwd(), [SECRET])).toThrow(/inside a git worktree/);
  });

  it('redacts secret-named keys and known values anywhere', () => {
    expect(
      redact({ access_token: 'x', nested: [{ clientSecret: 'y', v: `a ${SECRET} b` }] }, [SECRET]),
    ).toEqual({
      access_token: REDACTED,
      nested: [{ clientSecret: REDACTED, v: `a ${REDACTED} b` }],
    });
  });
});
