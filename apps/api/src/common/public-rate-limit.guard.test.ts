import { describe, expect, it } from 'vitest';
import { counted } from './public-rate-limit.guard.js';

/** QR54-R1: only a complete, well-formed EXEC reply counts; anything else is no answer. */
describe('public rate limit: EXEC reply', () => {
  it('accepts INCR ≥ 1, PEXPIRE NX 0 or 1, PTTL > 0', () => {
    expect(
      counted([
        [null, 1],
        [null, 1],
        [null, 60_000],
      ]),
    ).toEqual({ current: 1, ttl: 60_000 });
    // PEXPIRE NX answers 0 while the window already runs: normal.
    expect(
      counted([
        [null, 7],
        [null, 0],
        [null, 1_234],
      ]),
    ).toEqual({ current: 7, ttl: 1_234 });
  });

  it.each([
    ['an aborted transaction (null)', null],
    ['a short reply', [[null, 1]]],
    [
      'a failed INCR',
      [
        [new Error('WRONGTYPE'), null],
        [null, 1],
        [null, 60_000],
      ],
    ],
    [
      'a failed PTTL',
      [
        [null, 1],
        [null, 1],
        [new Error('x'), null],
      ],
    ],
    [
      'a non-numeric counter',
      [
        [null, '3'],
        [null, 1],
        [null, 60_000],
      ],
    ],
    [
      'a zero counter',
      [
        [null, 0],
        [null, 1],
        [null, 60_000],
      ],
    ],
    [
      'an unexpected PEXPIRE',
      [
        [null, 1],
        [null, 2],
        [null, 60_000],
      ],
    ],
    [
      'a key without expiry',
      [
        [null, 1],
        [null, 0],
        [null, -1],
      ],
    ],
    [
      'a missing key',
      [
        [null, 1],
        [null, 1],
        [null, -2],
      ],
    ],
  ])('refuses %s', (_what, reply) => {
    expect(() => counted(reply as never)).toThrow();
  });
});
