/**
 * The only destinations a web page redirects to after sign-in or a site choice: a same-site path
 * of printable ASCII. Absolute URLs, protocol-relative "//host", backslashes (browsers read "/\\x"
 * as "//x"), control and non-ASCII characters and API paths fall back to "/". Mirrors the API's
 * safeNextPath (apps/api/src/identity/safe-path.ts).
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if ([...value].some((c) => c.charCodeAt(0) < 0x21 || c.charCodeAt(0) > 0x7e)) return '/';
  if (value.startsWith('/api/')) return '/';
  return value;
}
