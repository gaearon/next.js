'use client'

import type { ReactNode } from 'react'
import { createElement, Fragment } from 'react'
// eslint-disable-next-line import/no-extraneous-dependencies
import { createFromReadableStream as createFromReadableStreamBrowser } from 'react-server-dom-webpack/client'
import type {
  CacheNodeSeedData,
  FlightRouterState,
} from '../../../shared/lib/app-router-types'
import { PAGE_SEGMENT_KEY } from '../../../shared/lib/segment'
import type { NormalizedFlightData } from '../../flight-data-helpers'
import { ClientPageRoot } from '../client-page'
import OuterLayoutRouter from '../layout-router'
import RenderFromTemplateContext from '../render-from-template-context'
import { callServer } from '../../app-call-server'
import { findSourceMapURL } from '../../app-find-source-map-url'

const createFromReadableStream =
  createFromReadableStreamBrowser as (typeof import('react-server-dom-webpack/client.browser'))['createFromReadableStream']

/**
 * A route whose every segment below the root layout is a Client Component.
 * The browser renders it from the module graph; navigation needs no data
 * from a server. `ref` is a self-contained flight payload that decodes to
 * the page's client module reference.
 */
export type ClientOnlyRoute = {
  page: string
  paramKeys: string[]
  ref: string
}

type MatchedRoute = {
  route: ClientOnlyRoute
  params: { [key: string]: string }
}

declare global {
  interface Window {
    __NEXT_CLIENT_ROUTES__?: ClientOnlyRoute[]
  }
}

const componentCache = new Map<string, Promise<React.ComponentType<any>>>()

function getRoutes(): ClientOnlyRoute[] {
  return typeof window !== 'undefined' && window.__NEXT_CLIENT_ROUTES__
    ? window.__NEXT_CLIENT_ROUTES__
    : []
}

function matchClientOnlyRoute(pathname: string): MatchedRoute | null {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname
  const parts = normalized.split('/').filter(Boolean)

  for (const route of getRoutes()) {
    const patternParts = route.page.split('/').filter(Boolean)
    if (patternParts.length !== parts.length) {
      continue
    }
    const params: { [key: string]: string } = {}
    let matched = true
    for (let i = 0; i < patternParts.length; i++) {
      const pattern = patternParts[i]
      const paramMatch = /^\[([^\]]+)\]$/.exec(pattern)
      if (paramMatch) {
        params[paramMatch[1]] = decodeURIComponent(parts[i])
      } else if (pattern !== parts[i]) {
        matched = false
        break
      }
    }
    if (matched) {
      return { route, params }
    }
  }
  return null
}

function decodePageComponent(
  route: ClientOnlyRoute
): Promise<React.ComponentType<any>> {
  let cached = componentCache.get(route.page)
  if (!cached) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(route.ref))
        controller.close()
      },
    })
    cached = createFromReadableStream<React.ComponentType<any>>(stream, {
      callServer,
      findSourceMapURL,
    })
    componentCache.set(route.page, cached)
  }
  return cached
}

/**
 * Builds the FlightRouterState for the matched route, mirroring what the
 * server would send for a root render of the same URL.
 */
function buildTree(match: MatchedRoute, search: string): FlightRouterState {
  const pageSegment =
    search && search !== '?' ? `${PAGE_SEGMENT_KEY}${search}` : PAGE_SEGMENT_KEY
  let tree: FlightRouterState = [pageSegment, {}]
  const patternParts = match.route.page.split('/').filter(Boolean)
  for (let i = patternParts.length - 1; i >= 0; i--) {
    const pattern = patternParts[i]
    const paramMatch = /^\[([^\]]+)\]$/.exec(pattern)
    // Dynamic segment tuples carry [paramName, paramCacheKey, paramType,
    // staticSiblings]. There are no known static siblings for a synthesized
    // route; null means "assume dynamic".
    const segment = paramMatch
      ? ([paramMatch[1], match.params[paramMatch[1]], 'd', null] as any)
      : pattern
    tree = [segment as any, { children: tree }]
  }
  return ['', { children: tree }]
}

/**
 * Mirrors what the server renders for each segment of the new subtree. A
 * segment without a layout renders a fragment holding the layout-router for
 * its child; the page segment renders `ClientPageRoot` around the decoded
 * page component, with `serverProvidedParams: null` so params and search
 * params derive on the client.
 */
function buildSeedData(
  tree: FlightRouterState,
  pageNode: ReactNode
): CacheNodeSeedData {
  const [, parallelRoutes] = tree
  const childTree = parallelRoutes.children
  if (!childTree) {
    return [
      createElement(Fragment, { key: 'c' }, pageNode),
      {},
      null,
      false,
      null,
    ]
  }
  const segmentNode = createElement(Fragment, { key: 'c' }, [
    null,
    createElement(OuterLayoutRouter, {
      key: 'r',
      parallelRouterKey: 'children',
      error: undefined,
      errorStyles: undefined,
      errorScripts: undefined,
      template: createElement(RenderFromTemplateContext),
      templateStyles: undefined,
      templateScripts: undefined,
      notFound: undefined,
      forbidden: undefined,
      unauthorized: undefined,
    } as any),
  ])
  return [
    segmentNode,
    { children: buildSeedData(childTree, pageNode) },
    null,
    false,
    null,
  ]
}

export type ClientOnlyNavigationResult = {
  flightData: NormalizedFlightData[]
  canonicalUrl: URL
  renderedSearch: string
}

/**
 * Attempts to satisfy a navigation locally. Returns null when the target
 * isn't a client-only route — the caller then fetches, exactly as before.
 */
export async function navigateClientOnly(
  url: URL
): Promise<ClientOnlyNavigationResult | null> {
  const match = matchClientOnlyRoute(url.pathname)
  if (!match) {
    return null
  }

  const Component = await decodePageComponent(match.route)
  const pageNode = createElement(ClientPageRoot, {
    Component,
    serverProvidedParams: null,
  })

  const tree = buildTree(match, url.search)
  const seedData = buildSeedData(tree[1].children!, pageNode)
  const rootSeedData: CacheNodeSeedData = [
    null,
    { children: seedData },
    null,
    false,
    null,
  ]

  return {
    flightData: [
      {
        segmentPath: [],
        pathToSegment: [],
        segment: '',
        tree,
        seedData: rootSeedData,
        head: null,
        isHeadPartial: false,
        isRootRender: true,
      },
    ],
    canonicalUrl: url,
    renderedSearch: url.search,
  }
}
