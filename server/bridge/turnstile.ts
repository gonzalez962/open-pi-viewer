/** Server-only Cloudflare verification. Never logs credentials or upstream payloads. */
const CLOUDFLARE_TEST_SECRETS = new Set([
  '1x0000000000000000000000000000000AA', // Always pass (public testing credential).
  '2x0000000000000000000000000000000AA', // Always fail.
  '3x0000000000000000000000000000000AA', // Already spent token.
]);
const LOCAL_TEST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export async function verifyTurnstile(
  secret: string,
  token: string,
  host: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<'valid' | 'invalid' | 'unavailable'> {
  let hostname: string;
  try {
    if (typeof host !== 'string') return 'invalid';
    const url = new URL(`https://${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return 'invalid';
    hostname = url.hostname;
  } catch {
    return 'invalid';
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }).toString(),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) return 'unavailable';
    const value: unknown = await res.json();
    if (typeof value !== 'object' || value === null) return 'invalid';
    const data = value as Record<string, unknown>;
    // Official dummy responses have hostname example.com and no action.
    // Only server-configured PUBLIC dummy credentials on local hosts may
    // omit production binding; upstream success and the access key still apply.
    if (CLOUDFLARE_TEST_SECRETS.has(secret) && LOCAL_TEST_HOSTS.has(hostname.toLowerCase()) &&
        token === 'XXXX.DUMMY.TOKEN.XXXX') {
      return data.success === true ? 'valid' : 'invalid';
    }
    return data.success === true && data.action === 'login' &&
      typeof data.hostname === 'string' && data.hostname.toLowerCase() === hostname.toLowerCase()
      ? 'valid' : 'invalid';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timeout);
  }
}
