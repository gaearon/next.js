/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  ...(process.env.IS_TURBOPACK_TEST
    ? {
        // The native watcher is unreliable on the local test host. Polling
        // isolates the ordering assertion from route-discovery failures.
        watchOptions: { pollIntervalMs: 100 },
      }
    : undefined),
}

module.exports = nextConfig
