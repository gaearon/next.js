import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'
import webdriver from 'next-webdriver'
import { createServer, Server } from 'http'
import { promises as fs } from 'fs'
import { extname, join } from 'path'

const skipStart = process.env.NEXT_TEST_MODE !== 'dev'

// A static file server for the exported out/ directory that records every
// request, so tests can assert a navigation happened without fetching route
// data.
function createStaticServer(root: string) {
  const requests: string[] = []
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.txt': 'text/plain; charset=utf-8',
    '.css': 'text/css',
  }
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url!, 'http://n').pathname)
    requests.push(pathname)
    const candidates = pathname.endsWith('/')
      ? [join(root, pathname, 'index.html')]
      : extname(pathname)
        ? [join(root, pathname)]
        : [join(root, `${pathname}.html`), join(root, pathname, 'index.html')]
    for (const file of candidates) {
      try {
        const data = await fs.readFile(file)
        res.writeHead(200, {
          'content-type': types[extname(file)] ?? 'application/octet-stream',
        })
        res.end(data)
        return
      } catch {}
    }
    res.writeHead(404)
    res.end('not found')
  })
  return { server, requests }
}

function dataRequests(requests: string[], routePrefix: string) {
  // Anything under the target route is navigation data (payload .txt files,
  // HEAD probes, HTML). JS chunks and other routes' background prefetches are
  // fine to load during a client-only navigation.
  return requests.filter(
    (pathname) =>
      pathname === routePrefix ||
      pathname.startsWith(`${routePrefix}.`) ||
      pathname.startsWith(`${routePrefix}/__next.`)
  )
}

describe('client-only-segments', () => {
  const { next, isNextStart } = nextTestSetup({
    files: __dirname,
    skipStart,
    skipDeployment: true,
    // A plain static file server can't echo the deployment id header back on
    // data requests, so skew protection would turn every navigation into an
    // MPA navigation. Same as segment-cache/export.
    disableAutoSkewProtection: true,
  })

  if (isNextStart) {
    let server: Server
    let requests: string[]
    let url: string

    beforeAll(async () => {
      const { exitCode } = await next.build()
      if (exitCode !== 0) {
        throw new Error(`next build failed with exit code ${exitCode}`)
      }
      const staticServer = createStaticServer(join(next.testDir, 'out'))
      server = staticServer.server
      requests = staticServer.requests
      await new Promise<void>((resolve) => server.listen(0, resolve))
      const address = server.address()
      url = `http://localhost:${typeof address === 'object' ? address!.port : address}`
    })

    afterAll(() => {
      server?.close()
    })

    it('navigates to a client-only segment without fetching route data', async () => {
      const browser = await webdriver(url, '/')
      await browser.eval('window.__nav_marker = "alive"')
      await browser.waitForIdleNetwork()
      requests.length = 0

      await browser.elementByCss('#to-spa').click()
      await retry(async () => {
        expect(await browser.elementByCss('#spa-content').text()).toBe(
          'spa-client-content'
        )
      })
      expect(await browser.eval('window.__nav_marker')).toBe('alive')
      expect(dataRequests(requests, '/spa')).toEqual([])

      // The page is interactive, not just painted.
      await browser.elementByCss('#counter').click()
      await retry(async () => {
        expect(await browser.elementByCss('#counter').text()).toBe('count: 1')
      })
    })

    it('navigates to a param that generateStaticParams never produced', async () => {
      const browser = await webdriver(url, '/')
      await browser.eval('window.__nav_marker = "alive"')
      await browser.waitForIdleNetwork()
      requests.length = 0

      await browser.elementByCss('#to-spa-9').click()
      await retry(async () => {
        expect(await browser.elementByCss('#spa-item').text()).toBe('item-9')
      })
      expect(await browser.eval('window.__nav_marker')).toBe('alive')
      expect(dataRequests(requests, '/spa/9')).toEqual([])
    })

    it('serves a server segment from its own route data', async () => {
      // Unlike the client-only route, a server segment has content the browser
      // can't produce, so its data is fetched from files addressed at the
      // route itself (whether during prefetching or at navigation time).
      requests.length = 0
      const browser = await webdriver(url, '/')

      await browser.elementByCss('#to-server').click()
      await retry(async () => {
        expect(await browser.elementByCss('#server-page').text()).toBe(
          'server-page-content'
        )
      })
      expect(dataRequests(requests, '/server-page').length).toBeGreaterThan(0)
    })

    it('does not emit files for non-generated params', async () => {
      // Client-only dynamic routes are navigable for any param, but a direct
      // load of a non-generated param 404s on a static host until pattern
      // shells exist.
      await expect(
        fs.access(join(next.testDir, 'out', 'spa', '9.html'))
      ).rejects.toThrow()
    })
  } else {
    it('renders and hydrates the client-only segment in dev', async () => {
      const browser = await next.browser('/spa')
      expect(await browser.elementByCss('#spa-content').text()).toBe(
        'spa-client-content'
      )
      await browser.elementByCss('#counter').click()
      await retry(async () => {
        expect(await browser.elementByCss('#counter').text()).toBe('count: 1')
      })
    })

    it('navigates client-side in dev', async () => {
      const browser = await next.browser('/')
      await browser.eval('window.__nav_marker = "alive"')
      await browser.elementByCss('#to-spa').click()
      await retry(async () => {
        expect(await browser.elementByCss('#spa-content').text()).toBe(
          'spa-client-content'
        )
      })
      expect(await browser.eval('window.__nav_marker')).toBe('alive')
    })

    it('renders any param for a client-only dynamic route in dev', async () => {
      const browser = await next.browser('/')
      await browser.elementByCss('#to-spa-9').click()
      await retry(async () => {
        expect(await browser.elementByCss('#spa-item').text()).toBe('item-9')
      })
    })
  }
})
