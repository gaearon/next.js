/**
 * Helpers for routes that export their fallback render at a pattern address.
 *
 * A dynamic route whose fallback render is fully static (for example, a
 * Client Component page — params derive in the browser) doesn't need per-param
 * files: its data is identical for every param value. The export writes that
 * data once, at the address the client segment cache already uses for
 * param-independent entries (`/spa/$d$id`), and navigation to any param value
 * is served from it.
 */

/**
 * Converts a dynamic route pattern to its pattern address, using the same
 * `$<type>$<name>` encoding as segment request keys. Returns null for
 * patterns the client can't compose locally (catch-all, optional catch-all,
 * parallel routes, interception).
 */
export function patternPathnameForRoute(pathname: string): string | null {
  const parts = pathname.split('/')
  const converted: string[] = []
  for (const part of parts) {
    if (part.startsWith('@') || part.startsWith('(.')) {
      return null
    }
    const match = /^\[([^\]]+)\]$/.exec(part)
    if (!match) {
      if (part.includes('[')) {
        return null
      }
      converted.push(part)
      continue
    }
    if (match[1].startsWith('...')) {
      return null
    }
    converted.push(`$d$${match[1]}`)
  }
  return converted.join('/')
}

/**
 * When a dynamic route produced no concrete paths, appends a copy of its
 * fallback entry addressed at the pattern. The entry flows through the
 * regular export pipeline: the fallback render enforces completeness like
 * any other export render, and the artifacts (HTML, route payload, segment
 * files) are written once, shared by every param value.
 */
export function appendPatternRoute<
  T extends {
    pathname: string
    encodedPathname: string
    fallbackRouteParams?: unknown[] | readonly unknown[] | null
  },
>(routes: T[]): T[] {
  const hasConcretePaths = routes.some(
    (route) =>
      !route.fallbackRouteParams || route.fallbackRouteParams.length === 0
  )
  if (hasConcretePaths) {
    return routes
  }
  const fallbackRoute = routes.find(
    (route) => route.fallbackRouteParams && route.fallbackRouteParams.length > 0
  )
  if (!fallbackRoute) {
    return routes
  }
  const patternPathname = patternPathnameForRoute(fallbackRoute.pathname)
  if (patternPathname === null) {
    return routes
  }
  return [
    ...routes,
    {
      ...fallbackRoute,
      pathname: patternPathname,
      encodedPathname: patternPathname,
    },
  ]
}
