import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import type { AppConfig } from '../src/config'

function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		apiKey: 'test-secret',
		corsOrigins: ['https://bedrocknexus.test'],
		generalRateLimit: 10,
		maxConcurrentStatusChecks: 2,
		statusRateLimit: 2,
		trustProxyHeaders: false,
		...overrides,
	}
}

describe('API routes', () => {
	test('serves health checks without authentication', async () => {
		const response = await createApp(createTestConfig()).request('/health')

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ status: 'healthy' })
	})

	test('requires an API key for verification codes', async () => {
		const app = createApp(createTestConfig())

		const unauthorized = await app.request('/server-verify/code', {
			method: 'POST',
		})
		expect(unauthorized.status).toBe(401)

		const authorized = await app.request('/server-verify/code', {
			headers: { 'X-API-Key': 'test-secret' },
			method: 'POST',
		})
		expect(authorized.status).toBe(200)
		expect((await authorized.json()).code).toMatch(/^[A-F0-9]{8}$/)
	})

	test('fails closed when API authentication is not configured', async () => {
		const app = createApp(createTestConfig({ apiKey: undefined }))
		const response = await app.request('/server-verify/code', {
			method: 'POST',
		})

		expect(response.status).toBe(503)
	})

	test('rejects invalid verification payloads before network access', async () => {
		const response = await createApp(createTestConfig()).request(
			'/server-verify/check',
			{
				body: JSON.stringify({
					code: 'wrong',
					host: 'example.com',
					method: 'motd_token',
					port: 19_132,
				}),
				headers: {
					'Content-Type': 'application/json',
					'X-API-Key': 'test-secret',
				},
				method: 'POST',
			},
		)

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			error: 'Verification code is invalid',
			verified: false,
		})
	})

	test('removes the legacy verification endpoints', async () => {
		const response = await createApp(createTestConfig()).request(
			'/minecraft/generate-code',
		)

		expect(response.status).toBe(404)
	})

	test('blocks private status targets and enforces the status limit', async () => {
		const app = createApp(createTestConfig({ statusRateLimit: 2 }))

		const first = await app.request('/minecraft/status?ip=127.0.0.1')
		const second = await app.request('/minecraft/status?ip=127.0.0.1')
		const limited = await app.request('/minecraft/status?ip=127.0.0.1')

		expect(first.status).toBe(400)
		expect(second.status).toBe(400)
		expect(limited.status).toBe(429)
	})

	test('applies configured CORS origins', async () => {
		const app = createApp(createTestConfig())
		const allowed = await app.request('/health', {
			headers: { Origin: 'https://bedrocknexus.test' },
		})
		const denied = await app.request('/health', {
			headers: { Origin: 'https://example.com' },
		})

		expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
			'https://bedrocknexus.test',
		)
		expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()
	})
})
