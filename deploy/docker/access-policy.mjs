export function isAllowedBrowserRequest(request, publicUrl, pathname) {
  if (request.headers.host?.toLowerCase() !== publicUrl.host.toLowerCase()) return false

  const origin = request.headers.origin
  if (origin !== undefined && origin !== publicUrl.origin) return false

  if (request.headers['sec-fetch-site'] !== 'cross-site') return true

  // A user may open DSH from another system in a normal browser tab. That
  // top-level navigation starts as cross-site, then the automatic-login
  // redirect must still be allowed to finish. Embedded iframes, API calls,
  // WebSockets and unsafe methods remain subject to the cross-site rejection.
  const mode = request.headers['sec-fetch-mode']
  const destination = request.headers['sec-fetch-dest']
  return request.method === 'GET' &&
    pathname === '/' &&
    mode === 'navigate' &&
    (destination === undefined || destination === 'document')
}
