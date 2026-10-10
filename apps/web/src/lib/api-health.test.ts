import { describe, expect, it, vi } from 'vitest';
import { fetchApiHealth } from './api-health';

const healthy = {
  status: 'ok',
  service: 'ayvo-api',
  environment: 'development',
  timestamp: '2026-10-10T12:00:00.000Z',
  checks: { database: 'up', redis: 'up' },
};

const respond = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('fetchApiHealth', () => {
  it('returns parsed health when the API answers', async () => {
    const fetchMock = respond(healthy);
    const result = await fetchApiHealth('http://api.test', fetchMock);

    expect(result).toEqual({ reachable: true, health: healthy });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://api.test/api/health');
  });

  it('never duplicates the /api prefix, even if the base URL carries a path', async () => {
    const fetchMock = respond(healthy);
    await fetchApiHealth('http://api.test/api/', fetchMock);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://api.test/api/health');
  });

  it('reports non-2xx responses', async () => {
    expect(await fetchApiHealth('http://api.test', respond({}, 503))).toEqual({
      reachable: false,
      error: 'HTTP 503',
    });
  });

  it('rejects responses that violate the shared contract', async () => {
    const result = await fetchApiHealth('http://api.test', respond({ status: 'fine' }));
    expect(result.reachable).toBe(false);
  });

  it('reports network failures instead of throwing', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchApiHealth('http://api.test', fetchMock)).toEqual({
      reachable: false,
      error: 'ECONNREFUSED',
    });
  });
});
