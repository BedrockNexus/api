import { describe, expect, test } from 'bun:test'
import type { AppConfig } from '../src/config'
import {
	ArtifactValidationError,
	assertAllowedArtifactUrl,
} from '../src/lib/artifact-validator'
import { createWorkerApp } from '../src/worker-app'

const config: AppConfig = {
	apiKey: 'test-secret',
	artifactAllowedHosts: ['storage.example.test'],
	corsOrigins: '*',
	generalRateLimit: 10,
	maxConcurrentStatusChecks: 2,
	maxQueuedStatusChecks: 2,
	statusRateLimit: 2,
	trustProxyHeaders: false,
}

describe('artifact validator', () => {
	test('only accepts HTTPS URLs on exact allowlisted hosts', () => {
		expect(
			assertAllowedArtifactUrl(
				'https://storage.example.test/artifact.mcpack?signature=ok',
				config.artifactAllowedHosts,
			).hostname,
		).toBe('storage.example.test')

		for (const url of [
			'http://storage.example.test/artifact.mcpack',
			'https://storage.example.test.attacker.invalid/artifact.mcpack',
			'https://127.0.0.1/artifact.mcpack',
		]) {
			expect(() =>
				assertAllowedArtifactUrl(url, config.artifactAllowedHosts),
			).toThrow(ArtifactValidationError)
		}
	})

	test('keeps worker validation private and validates request shapes', async () => {
		const app = createWorkerApp(config)
		const unauthorized = await app.request('/artifact-validate', {
			method: 'POST',
		})
		expect(unauthorized.status).toBe(401)

		const invalid = await app.request('/artifact-validate', {
			body: JSON.stringify({ type: 'unknown' }),
			headers: {
				'Content-Type': 'application/json',
				'X-API-Key': 'test-secret',
			},
			method: 'POST',
		})
		expect(invalid.status).toBe(400)
		expect(await invalid.json()).toEqual({
			error: 'Invalid validation request',
		})
	})

	test('no longer validates worlds or skins', async () => {
		const app = createWorkerApp(config)
		for (const [type, fileName] of [
			['map', 'world.mcworld'],
			['skin', 'skin.png'],
		]) {
			const response = await app.request('/artifact-validate', {
				body: JSON.stringify({
					downloadUrl: `https://storage.example.test/${fileName}`,
					fileName,
					fileSize: 1024,
					type,
				}),
				headers: {
					'Content-Type': 'application/json',
					'X-API-Key': 'test-secret',
				},
				method: 'POST',
			})
			expect(response.status).toBe(400)
		}
	})
})
