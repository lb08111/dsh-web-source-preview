const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * Let DSH's authentication cookie survive a top-level navigation started by
 * another origin. DSH mints this cookie as SameSite=Strict; the browser then
 * omits it on the automatic-login redirect, which produces a redirect loop.
 *
 * Only the authentication cookie is relaxed. Every other cookie and every
 * security attribute (notably HttpOnly, Secure, Path and Expires) is kept.
 *
 * @param {string[] | undefined} cookies - Set-Cookie header values from DSH.
 * @returns {string[] | undefined} The same headers with authentication cookies
 *   changed from SameSite=Strict to SameSite=Lax.
 */
export function relaxAuthCookieSameSite(cookies) {
  if (!Array.isArray(cookies)) return cookies
  return cookies.map(cookie => {
    if (!cookie.trimStart().startsWith(AUTH_COOKIE_PREFIX)) return cookie
    return cookie.replace(/;\s*SameSite=Strict(?=;|$)/i, '; SameSite=Lax')
  })
}
