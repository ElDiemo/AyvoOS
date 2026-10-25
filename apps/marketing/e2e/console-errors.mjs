/**
 * Console errors other than one expected error: exactly one entry with exactly that text AT exactly
 * that URL is removed; if it is missing (or repeated) nothing is removed, so any other error —
 * including when the expected one never came — still fails the test.
 */
export function withoutExpected(errors, expected) {
  const hits = errors.filter((e) => e.text === expected.text && e.url === expected.url);
  if (hits.length !== 1) return errors;
  return errors.filter((e) => e !== hits[0]);
}
