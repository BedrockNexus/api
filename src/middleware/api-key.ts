import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

export function hasValidApiKey(
	providedKey: string | undefined,
	expectedKey: string | undefined,
) {
	if (!(providedKey && expectedKey)) {
		return false
	}

	const provided = Buffer.from(providedKey)
	const expected = Buffer.from(expectedKey)
	return (
		provided.length === expected.length && timingSafeEqual(provided, expected)
	)
}

export function requireApiKey(apiKey: string | undefined): MiddlewareHandler {
	return async (c, next) => {
		if (!apiKey) {
			return c.json({ error: 'API authentication is not configured' }, 503)
		}

		if (!hasValidApiKey(c.req.header('X-API-Key'), apiKey)) {
			return c.json({ error: 'Unauthorized' }, 401)
		}

		await next()
	}
}
