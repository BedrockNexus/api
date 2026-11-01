const QUERY_TIMEOUT_MS = 8000
const TRAILING_SLASH_PATTERN = /\/+$/

/** Convex could not be reached or sent something other than a query result. */
export class ConvexUnavailableError extends Error {}

/** Convex ran the query and it failed, for example on a malformed cursor. */
export class ConvexQueryError extends Error {}

export type ConvexQuery = <Result>(
	path: string,
	args?: Record<string, unknown>,
) => Promise<Result>

/** Calls public Convex queries over its HTTP API. */
export function createConvexQuery(convexUrl: string): ConvexQuery {
	const endpoint = `${convexUrl.replace(TRAILING_SLASH_PATTERN, '')}/api/query`

	return async <Result>(path: string, args: Record<string, unknown> = {}) => {
		let body: { errorMessage?: string; status?: string; value?: Result }
		try {
			const response = await fetch(endpoint, {
				body: JSON.stringify({ args, format: 'json', path }),
				headers: { 'Content-Type': 'application/json' },
				method: 'POST',
				signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
			})
			body = (await response.json()) as typeof body
		} catch (error) {
			throw new ConvexUnavailableError(`Could not query ${path}`, {
				cause: error,
			})
		}

		if (body?.status === 'success') {
			return body.value as Result
		}
		if (body?.status === 'error') {
			throw new ConvexQueryError(`${path} failed: ${body.errorMessage}`)
		}
		throw new ConvexUnavailableError(`Unexpected response from ${path}`)
	}
}
