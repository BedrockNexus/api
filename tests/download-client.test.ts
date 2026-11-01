import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
	ConvexMutationError,
	createConvexMutation,
} from '../src/lib/convex-mutation'
import { downloadClientKey } from '../src/lib/download-client'

describe('download identity', () => {
	test('matches Hub hashing and ignores forged leftmost addresses', () => {
		const headers = new Headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.4' })
		const expected = createHash('sha256')
			.update(['secret', 'client', '203.0.113.4'].join('\0'))
			.digest('hex')
		expect(
			downloadClientKey('secret', headers, { trustProxyHeaders: true }),
		).toBe(expected)
	})
	test('requires explicit trust and respects configured proxy hops', () => {
		const a = new Headers({
			'x-forwarded-for': '1.1.1.1, 203.0.113.4, 10.0.0.1',
		})
		const b = new Headers({ 'x-forwarded-for': '203.0.113.4' })
		expect(downloadClientKey('secret', a, { trustProxyHeaders: false })).toBe(
			downloadClientKey('secret', b, { trustProxyHeaders: false }),
		)
		expect(
			downloadClientKey('secret', a, {
				trustProxyHeaders: true,
				trustedProxyHops: 2,
			}),
		).toBe(downloadClientKey('secret', b, { trustProxyHeaders: true }))
	})
})

test('calls the Convex mutation transport and preserves structured rate limit errors', async () => {
	let received: unknown
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			expect(new URL(request.url).pathname).toBe('/api/mutation')
			received = await request.json()
			return Response.json({
				status: 'error',
				errorMessage: 'limited',
				errorData: { code: 'RATE_LIMITED', retryAfterMs: 3000 },
			})
		},
	})
	try {
		const mutate = createConvexMutation(server.url.toString())
		try {
			await mutate('functions/projects/versions:createDownloadUrl', {
				downloadSecret: 'server-only',
			})
			throw new Error('Expected a rejected mutation')
		} catch (error) {
			expect(error).toBeInstanceOf(ConvexMutationError)
			expect((error as ConvexMutationError).data).toEqual({
				code: 'RATE_LIMITED',
				retryAfterMs: 3000,
			})
		}
		expect(received).toEqual({
			path: 'functions/projects/versions:createDownloadUrl',
			args: { downloadSecret: 'server-only' },
			format: 'json',
		})
	} finally {
		server.stop(true)
	}
})
