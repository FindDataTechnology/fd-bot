// Shared token cache: a short-lived platform access token per credential set.
//
// Ported from paas adapter plumbing. `fetchToken` resolves
// `{ token, expiresInSec }`; the cache expires 60s early so an in-flight request
// never races the real expiry.
export function tokenCache(fetchToken) {
  let token = null;
  let expiresAt = 0;
  return {
    async get() {
      if (token && Date.now() < expiresAt) return token;
      const fresh = await fetchToken();
      token = fresh.token;
      expiresAt = Date.now() + Math.max(0, (fresh.expiresInSec ?? 7200) - 60) * 1000;
      return token;
    },
    invalidate() {
      token = null;
      expiresAt = 0;
    },
  };
}
