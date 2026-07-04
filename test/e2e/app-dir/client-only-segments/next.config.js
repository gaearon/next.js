/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  cacheComponents: true,
  output: 'export',
  experimental: {
    clientOnlySegments: true,
  },
}

module.exports = nextConfig
