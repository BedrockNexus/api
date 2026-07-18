import { describe, expect, test } from 'bun:test'
import type { AppConfig } from '../src/config'
import {
	ArtifactValidationError,
	assertAllowedArtifactUrl,
	validateModelText,
	validateSkinBytes,
} from '../src/lib/artifact-validator'
import { createWorkerApp } from '../src/worker-app'

function pngChunk(type: string, data: number[] = []) {
	const chunk = new Uint8Array(12 + data.length)
	const view = new DataView(chunk.buffer)
	view.setUint32(0, data.length)
	for (const [index, character] of [...type].entries()) {
		chunk[4 + index] = character.charCodeAt(0)
	}
	chunk.set(data, 8)
	return chunk
}

function createSkinPng(width = 64, height = 64, animated = false) {
	const header = new Uint8Array(13)
	const view = new DataView(header.buffer)
	view.setUint32(0, width)
	view.setUint32(4, height)
	header.set([8, 6, 0, 0, 0], 8)
	const chunks = [pngChunk('IHDR', [...header])]
	if (animated) {
		chunks.push(pngChunk('acTL', [0, 0, 0, 1, 0, 0, 0, 0]))
	}
	chunks.push(pngChunk('IDAT', [1]), pngChunk('IEND'))
	const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
	const result = new Uint8Array(
		signature.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0),
	)
	result.set(signature)
	let offset = signature.length
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.length
	}
	return result
}

const config: AppConfig = {
	apiKey: 'test-secret',
	artifactAllowedHosts: ['storage.example.test'],
	corsOrigins: '*',
	generalRateLimit: 10,
	maxConcurrentStatusChecks: 2,
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

	test('accepts complete 64x64 PNG skins', () => {
		expect(validateSkinBytes(createSkinPng())).toEqual({
			height: 64,
			width: 64,
		})
	})

	test('rejects wrong-size, animated, and incomplete skins', () => {
		expect(() => validateSkinBytes(createSkinPng(128, 128))).toThrow(
			'Skins must be exactly 64x64 pixels',
		)
		expect(() => validateSkinBytes(createSkinPng(64, 64, true))).toThrow(
			'Animated PNG skins are not supported',
		)
		expect(() => validateSkinBytes(createSkinPng().slice(0, -12))).toThrow(
			'Skin PNG is incomplete',
		)
	})

	test('requires Blockbench textures to be embedded', () => {
		expect(
			validateModelText(
				JSON.stringify({
					elements: [{}],
					meta: { model_format: 'bedrock' },
					textures: [{ source: 'data:image/png;base64,AA==' }],
				}),
			),
		).toEqual({
			elementCount: 1,
			modelFormat: 'bedrock',
			textureCount: 1,
		})
		expect(() =>
			validateModelText(
				JSON.stringify({ textures: [{ source: 'https://example.com/a.png' }] }),
			),
		).toThrow('Model textures must be embedded')
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
})
