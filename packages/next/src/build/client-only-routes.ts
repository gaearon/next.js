import { promises as fs } from 'fs'
import path from 'path'

/**
 * A route qualifies as client-only when every segment module below the root
 * layout is a Client Component: the page itself and any layouts between it
 * and the root. Navigating to such a route needs no data from a server — the
 * shared root layout is already mounted, and the browser can render the rest
 * from the module graph. The classification is done from source directives:
 * whether a module is a Client Component is decided by its `'use client'`
 * directive, so reading the directive is exactly as authoritative as asking
 * the compiler.
 */
export type ClientOnlyRoute = {
  /** The route pattern, e.g. `/spa/[id]`. */
  page: string
  /** The denormalized page path, e.g. `/(group)/spa/[id]/page`. */
  pageKey: string
  /** The page file on disk. */
  pageFile: string
  /** Dynamic param keys in the order they appear in the pattern. */
  paramKeys: string[]
  /**
   * A self-contained flight payload that decodes to the page's client module
   * reference. Filled in after the compile step; null until then.
   */
  ref: string | null
}

export const CLIENT_ONLY_ROUTES_MANIFEST = 'client-only-routes.json'

const LAYOUT_FILE = /^layout\.(js|jsx|ts|tsx)$/

async function hasUseClientDirective(file: string): Promise<boolean> {
  const source = await fs.readFile(file, 'utf8')
  // The directive must appear before any other statement. Strip comments and
  // whitespace from the prologue, then look for the directive literal.
  const prologue = source.slice(0, 1024)
  const withoutComments = prologue
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trimStart()
  return /^(['"])use client\1/.test(withoutComments)
}

function paramKeysFromPage(page: string): string[] {
  const keys: string[] = []
  for (const part of page.split('/')) {
    const match = /^\[(?:\.\.\.)?([^\]]+)\]$/.exec(part)
    if (match) {
      keys.push(match[1])
    }
  }
  return keys
}

async function findSegmentFile(
  dir: string,
  pattern: RegExp
): Promise<string | null> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (pattern.test(entry)) {
      return path.join(dir, entry)
    }
  }
  return null
}

/**
 * Classifies the given app routes. `appPages` maps a denormalized page path
 * (e.g. `/(group)/spa/[id]/page`) to its normalized route and page file.
 */
export async function collectClientOnlyRoutes(
  appDir: string,
  appPages: ReadonlyMap<string, { page: string; pageFile: string }>
): Promise<ClientOnlyRoute[]> {
  const routes: ClientOnlyRoute[] = []

  for (const [pageKey, { page, pageFile }] of appPages) {
    // Catch-all params, parallel routes, and interception routes take extra
    // rules that the prototype doesn't implement; only plain static and
    // `[param]` segments qualify.
    const parts = page.split('/').filter(Boolean)
    if (
      parts.some(
        (part) =>
          part.startsWith('@') || part.startsWith('(.') || part.includes('...')
      )
    ) {
      continue
    }

    if (!(await hasUseClientDirective(pageFile))) {
      continue
    }

    // Every layout between the page and the root layout must also be a
    // Client Component. The root layout itself stays server-rendered; it is
    // shared with every navigation source, so it's never part of the new
    // subtree.
    let qualifies = true
    let dir = path.dirname(pageFile)
    while (path.resolve(dir) !== path.resolve(appDir)) {
      const layoutFile = await findSegmentFile(dir, LAYOUT_FILE)
      if (layoutFile && !(await hasUseClientDirective(layoutFile))) {
        qualifies = false
        break
      }
      dir = path.dirname(dir)
    }
    if (!qualifies) {
      continue
    }

    routes.push({
      page,
      pageKey,
      pageFile,
      paramKeys: paramKeysFromPage(page),
      ref: null,
    })
  }

  return routes.sort((a, b) => a.page.localeCompare(b.page))
}

type ClientReferenceManifest = {
  clientModules: {
    [key: string]: { id: string | number; chunks: string[] }
  }
}

/**
 * Fills in `ref` for each route: a two-row flight payload referencing the
 * page's client module, assembled from the route's client reference manifest.
 * Routes whose page module didn't compile as a client reference (or whose
 * manifest can't be found) keep `ref: null` and are dropped by the caller —
 * navigation to them falls back to fetching.
 */
export function resolveClientOnlyRouteRefs(
  routes: ClientOnlyRoute[],
  appDir: string,
  distDir: string
): void {
  for (const route of routes) {
    const manifestFile = path.join(
      distDir,
      'server',
      'app',
      `${route.pageKey.replace(/^\//, '')}_client-reference-manifest.js`
    )
    let manifest: ClientReferenceManifest | undefined
    try {
      const globalScope = globalThis as {
        __RSC_MANIFEST?: { [page: string]: ClientReferenceManifest }
      }
      globalScope.__RSC_MANIFEST ??= {}
      require(manifestFile)
      manifest = globalScope.__RSC_MANIFEST[route.pageKey]
    } catch {
      continue
    }
    if (!manifest) {
      continue
    }

    // Client module keys are bundler paths ending with the file's
    // project-relative path; match on the app-dir-relative suffix.
    const suffix = `${path.basename(appDir)}/${path
      .relative(appDir, route.pageFile)
      .replace(/\\/g, '/')}`
    for (const [key, value] of Object.entries(manifest.clientModules)) {
      if (!key.endsWith(`/${suffix}`) && key !== suffix) {
        continue
      }
      const chunks = value.chunks.map((chunk) =>
        chunk.startsWith('/') ? chunk : `/_next/${chunk}`
      )
      route.ref = `1:I[${JSON.stringify(value.id)},${JSON.stringify(
        chunks
      )},"default"]\n0:"$1"\n`
      break
    }
  }
}

/**
 * On-demand classification for the dev server, which has no build pass. The
 * page directory is resolved by walking the route's own segments; anything
 * that doesn't resolve plainly (route groups, parallel routes) returns false
 * and keeps the regular enforcement.
 */
export async function isClientOnlyRoute(
  appDir: string,
  page: string
): Promise<boolean> {
  const parts = page.split('/').filter(Boolean)
  if (
    parts.some(
      (part) =>
        part.startsWith('@') || part.startsWith('(') || part.includes('...')
    )
  ) {
    return false
  }
  let dir = appDir
  for (const part of parts) {
    dir = path.join(dir, part)
  }
  const pageFile = await findSegmentFile(dir, /^page\.(js|jsx|ts|tsx)$/)
  if (!pageFile || !(await hasUseClientDirective(pageFile))) {
    return false
  }
  while (path.resolve(dir) !== path.resolve(appDir)) {
    const layoutFile = await findSegmentFile(dir, LAYOUT_FILE)
    if (layoutFile && !(await hasUseClientDirective(layoutFile))) {
      return false
    }
    dir = path.dirname(dir)
  }
  return true
}
