import { nextTestSetup } from 'e2e-utils'
import { retry, waitFor } from 'next-test-utils'
import WebSocket from 'ws'

describe('atomic-dev-route-snapshot', () => {
  const { next, isTurbopack } = nextTestSetup({
    files: __dirname,
    skipStart: true,
  })

  beforeAll(async () => {
    await next.start()
  })

  if (!isTurbopack) {
    it('keeps serving the committed routes while discovering a new route', async () => {
      const initialResponse = await next.fetch('/robots.txt')
      expect(initialResponse.status).toBe(200)
      await initialResponse.arrayBuffer()

      const requestCommittedRoute = async () => {
        const response = await next.fetch('/robots.txt')
        await response.arrayBuffer()
        return response.status
      }
      const pageStatuses: number[] = []
      let keepProbing = true
      const requestLoop = (async () => {
        while (keepProbing) {
          pageStatuses.push(
            ...(await Promise.all(
              Array.from({ length: 5 }, requestCommittedRoute)
            ))
          )
          await waitFor(10)
        }
      })()

      await next.patchFile(
        'app/icon.tsx',
        `import { ImageResponse } from 'next/og'

export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(<div style={{ background: 'black' }}>N</div>)
}`
      )
      await next.patchFile(
        'app/added/page.tsx',
        `export default function Added() { return <p>added</p> }`
      )

      try {
        await retry(async () => {
          const response = await next.fetch('/added')
          const status = response.status
          await response.arrayBuffer()
          expect(status).toBe(200)
        }, 15_000)
      } finally {
        keepProbing = false
        await requestLoop
        await next.stop('SIGTERM')
      }

      expect(pageStatuses.length).toBeGreaterThan(0)
      expect(new Set(pageStatuses)).toEqual(new Set([200]))
    })
  } else {
    it('announces an added route only after it can be served', async () => {
      const initialResponse = await next.fetch('/')
      expect(initialResponse.status).toBe(200)
      await initialResponse.arrayBuffer()

      const socket = new WebSocket(`ws://localhost:${next.appPort}/_next/hmr`, {
        origin: next.url,
      })
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })

      let responseAtAnnouncement:
        | {
            status: number
            body: string
          }
        | undefined
      let announcementError: unknown
      socket.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString())
          if (message.type === 'addedPage' && message.data?.[0] === '/added') {
            const response = await next.fetch('/added')
            responseAtAnnouncement = {
              status: response.status,
              body: await response.text(),
            }
          }
        } catch (error) {
          announcementError = error
        }
      })

      // Static metadata analysis makes the Watchpack scan observably async,
      // widening the otherwise timing-dependent gap between the two watchers.
      await next.patchFile(
        'app/icon.tsx',
        `import { ImageResponse } from 'next/og'

export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(<div style={{ background: 'black' }}>N</div>)
}`
      )
      await next.patchFile(
        'app/added/page.tsx',
        `export default function Added() { return <p>added</p> }`
      )

      try {
        await retry(async () => {
          if (announcementError) throw announcementError
          expect(responseAtAnnouncement?.status).toBe(200)
          expect(responseAtAnnouncement?.body).toContain('<p>added</p>')
        }, 15_000)
      } finally {
        socket.terminate()
        await next.stop('SIGTERM')
      }
    })
  }
})
