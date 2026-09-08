import { neon, neonConfig, type NeonQueryFunction } from '@neondatabase/serverless'

let cached: NeonQueryFunction<false, false> | null = null

/**
 * Neon's HTTP driver. Lazily created so `next build` does not need DATABASE_URL.
 *
 * `NEON_FETCH_ENDPOINT` redirects the driver at scripts/neon-http-proxy.mjs so
 * the app can run against a throwaway local Postgres. It is a development
 * convenience and is ignored in production.
 */
export function getSql(): NeonQueryFunction<false, false> {
  if (!cached) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')

    const endpoint = process.env.NEON_FETCH_ENDPOINT
    if (endpoint && process.env.NODE_ENV !== 'production') {
      neonConfig.fetchEndpoint = endpoint
    }

    cached = neon(url)
  }
  return cached
}
