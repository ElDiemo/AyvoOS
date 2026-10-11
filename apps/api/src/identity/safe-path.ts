/**
 * The only post-login destinations: a same-site path. Anything else (absolute URLs,
 * protocol-relative "//host", backslashes, control characters) falls back to "/".
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if ([...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return '/';
  if (value.startsWith('/api/')) return '/';
  return value;
}
