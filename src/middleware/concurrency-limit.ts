import type { Context, MiddlewareHandler } from 'hono'

interface ConcurrencyLimitOptions {
	/** How many queueing requests may wait at once before they are rejected. */
	maxQueued?: number
	/** Requests that wait for a free slot instead of being rejected. */
	shouldQueue?: (c: Context) => boolean
}

export function concurrencyLimit(
	maxConcurrent: number,
	options: ConcurrencyLimitOptions = {},
): MiddlewareHandler {
	const maxQueued = options.maxQueued ?? 0
	const waiting: Array<() => void> = []
	let activeRequests = 0

	const release = () => {
		// Hand the slot straight to the next waiter so a new arrival cannot
		// take it first.
		const next = waiting.shift()
		if (next) {
			next()
		} else {
			activeRequests -= 1
		}
	}

	return async (c, next) => {
		if (activeRequests < maxConcurrent) {
			activeRequests += 1
		} else if (options.shouldQueue?.(c) && waiting.length < maxQueued) {
			await new Promise<void>((resolve) => waiting.push(resolve))
		} else {
			c.header('Retry-After', '1')
			return c.json(
				{ error: 'Too many server checks are already running' },
				503,
			)
		}

		try {
			await next()
		} finally {
			release()
		}
	}
}
