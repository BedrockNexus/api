import type { MiddlewareHandler } from 'hono'

export function concurrencyLimit(maxConcurrent: number): MiddlewareHandler {
	let activeRequests = 0

	return async (c, next) => {
		if (activeRequests >= maxConcurrent) {
			c.header('Retry-After', '1')
			return c.json(
				{ error: 'Too many server checks are already running' },
				503,
			)
		}

		activeRequests += 1
		try {
			await next()
		} finally {
			activeRequests -= 1
		}
	}
}
