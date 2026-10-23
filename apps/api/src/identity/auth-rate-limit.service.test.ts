import { describe, expect, it } from 'vitest';
import { afterHit, beforeHit } from './auth-rate-limit.service.js';

/** Only a complete, well-formed EXEC reply counts; anything else is no answer (fail closed). */
describe('sign-in rate limit: EXEC replies', () => {
  it('counting: INCR ≥ 1, PEXPIRE NX 0 or 1, PTTL > 0', () => {
    expect(
      afterHit([
        [null, 1],
        [null, 1],
        [null, 600_000],
      ]),
    ).toEqual({ current: 1, ttl: 600_000 });
    expect(
      afterHit([
        [null, 4],
        [null, 0],
        [null, 12],
      ]),
    ).toEqual({ current: 4, ttl: 12 });
  });

  it.each([
    ['an aborted transaction', null],
    ['a short reply', [[null, 1]]],
    [
      'a failed INCR',
      [
        [new Error('WRONGTYPE'), null],
        [null, 1],
        [null, 1000],
      ],
    ],
    [
      'a non-numeric counter',
      [
        [null, '2'],
        [null, 1],
        [null, 1000],
      ],
    ],
    [
      'a zero counter',
      [
        [null, 0],
        [null, 1],
        [null, 1000],
      ],
    ],
    [
      'an unexpected PEXPIRE',
      [
        [null, 1],
        [null, 5],
        [null, 1000],
      ],
    ],
    [
      'no window',
      [
        [null, 1],
        [null, 0],
        [null, -1],
      ],
    ],
  ])('counting refuses %s', (_what, reply) => {
    expect(() => afterHit(reply as never)).toThrow();
  });

  it('checking: no counter yet is zero (the normal state before a first attempt)', () => {
    expect(
      beforeHit(
        [
          [null, null],
          [null, -2],
        ],
        600_000,
      ),
    ).toEqual({ current: 0, ttl: 600_000 });
    expect(
      beforeHit(
        [
          [null, '3'],
          [null, 5_000],
        ],
        600_000,
      ),
    ).toEqual({ current: 3, ttl: 5_000 });
  });

  it.each([
    ['an aborted transaction', null],
    [
      'a failed GET (wrong type)',
      [
        [new Error('WRONGTYPE'), null],
        [null, 1000],
      ],
    ],
    [
      'a non-numeric value',
      [
        [null, 'abc'],
        [null, 1000],
      ],
    ],
    [
      'a negative value',
      [
        [null, '-1'],
        [null, 1000],
      ],
    ],
    [
      'a counter without a window',
      [
        [null, '1'],
        [null, -1],
      ],
    ],
    [
      'a missing value with a window',
      [
        [null, null],
        [null, 1000],
      ],
    ],
  ])('checking refuses %s', (_what, reply) => {
    expect(() => beforeHit(reply as never, 600_000)).toThrow();
  });
});
