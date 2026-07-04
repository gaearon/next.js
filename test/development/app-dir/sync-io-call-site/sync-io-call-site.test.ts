import { nextTestSetup } from 'e2e-utils'
import { retry, waitFor } from 'next-test-utils'
import path from 'path'

describe('sync-io-call-site', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    skipDeployment: true,
    dependencies: {
      'time-dep': `file:${path.join(__dirname, 'time-dep.tar')}`,
    },
  })

  it('names the dependency that read the time', async () => {
    await next.render('/dependency')
    await retry(() => {
      expect(next.cliOutput).toContain(
        'Route "/dependency": Next.js encountered the unstable value `Date.now()` from `time-dep` while prerendering.'
      )
    })
  })

  it('reports application code without a package name', async () => {
    await next.render('/application')
    await retry(() => {
      expect(next.cliOutput).toContain(
        'Route "/application": Next.js encountered the unstable value `Date.now()` while prerendering.'
      )
    })
  })

  it('does not track reads from framework internals', async () => {
    // graceful-fs (inside the compiled watchpack) reads `Date.now()` in its
    // fs.closeSync bookkeeping, synchronously inside this render.
    expect(await next.render('/internal')).toContain('file-size-')
    // Wait out a full background validation pass before asserting silence.
    await retry(() => {
      expect(next.cliOutput).toContain('GET /internal 200')
    })
    await waitFor(5000)
    expect(next.cliOutput).not.toContain(
      'Route "/internal": Next.js encountered the unstable value'
    )
  })
})
