import { type ConvexQuery, ConvexUnavailableError } from './convex-query'

export class ConvexMutationError extends Error {
	constructor(
		readonly data: unknown,
		message: string,
	) {
		super(message)
	}
}

/** Server-only download mutations authenticate with their shared redirect secret. */
export function createConvexMutation(convexUrl: string): ConvexQuery {
	return async <Result>(path: string, args: Record<string, unknown> = {}) => {
		let body: {
			status?: string
			value?: Result
			errorData?: unknown
			errorMessage?: string
		}
		try {
			const response = await fetch(
				`${convexUrl.replace(/\/+$/, '')}/api/mutation`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ path, args, format: 'json' }),
					signal: AbortSignal.timeout(8000),
					redirect: 'error',
				},
			)
			body = (await response.json()) as typeof body
		} catch {
			throw new ConvexUnavailableError('Download backend is unavailable')
		}
		if (body.status === 'success') return body.value as Result
		if (body.status === 'error')
			throw new ConvexMutationError(
				body.errorData,
				body.errorMessage ?? 'Download failed',
			)
		throw new ConvexUnavailableError('Unexpected download backend response')
	}
}
