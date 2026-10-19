import { describe, expect, it } from 'vitest';
import { CarrierProtocolError } from '../carrier.js';
import { PplClient } from './ppl-client.js';

const BASE = 'https://api.example.test/ecs/ppl/myapi2';
const BATCH = '3f0c1b8e-5d2a-4c7b-9a61-0e2f4d8c7b10';

/** A client whose "network" records every call and answers a token and a small PDF. */
function client() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/login/getAccessToken')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 1800 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('%PDF-1.4\n%%EOF\n', { headers: { 'content-type': 'application/pdf' } });
  }) as typeof fetch;
  const c = new PplClient(
    { code: 'PPL_TEST', environment: 'TEST', baseUrl: BASE, clientId: 'id', clientSecret: 's' },
    fetchImpl,
  );
  return { c, calls };
}
const signal = () => new AbortController().signal;

describe('PPL label downloads: only the expected endpoint', () => {
  it('the complete document only from shipment/batch/{this batch}/label with documented parameters', async () => {
    const { c } = client();
    const ok = `${BASE}/shipment/batch/${BATCH}/label?pageSize=A4&position=1&limit=200&offset=0`;
    await expect(
      c.download(ok, signal(), { kind: 'complete', batchId: BATCH }),
    ).resolves.toBeInstanceOf(Uint8Array);
    for (const bad of [
      `${BASE}/shipment/batch/00000000-0000-4000-8000-000000000000/label?limit=200&offset=0`,
      `${BASE}/shipment/batch/${BATCH}/label?limit=200&offset=0&redirect=https://x`,
      `${BASE}/shipment/batch/${BATCH}`,
      `${BASE}/data/${BATCH}`,
      `https://evil.example/ecs/ppl/myapi2/shipment/batch/${BATCH}/label`,
    ]) {
      const { c: fresh, calls } = client();
      await expect(
        fresh.download(bad, signal(), { kind: 'complete', batchId: BATCH }),
        bad,
      ).rejects.toBeInstanceOf(CarrierProtocolError);
      expect(calls, bad).toEqual([]); // no token was even requested
    }
  });

  it('a parcel label only under /data/ of the API', async () => {
    const { c } = client();
    await expect(c.download(`${BASE}/data/abc`, signal())).resolves.toBeInstanceOf(Uint8Array);
    await expect(c.download('/ecs/ppl/myapi2/data/abc', signal())).resolves.toBeInstanceOf(
      Uint8Array,
    );
    for (const bad of [
      `${BASE}/shipment/batch/${BATCH}/label`,
      `${BASE}/data/../shipment`,
      'https://user:pw@api.example.test/ecs/ppl/myapi2/data/abc',
    ]) {
      await expect(c.download(bad, signal()), bad).rejects.toBeInstanceOf(CarrierProtocolError);
    }
  });
});
