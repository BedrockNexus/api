import { describe, expect, spyOn, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	Uint8ArrayReader,
	Uint8ArrayWriter,
	ZipReader,
	ZipWriter,
} from '@zip.js/zip.js'
import type { AppConfig } from '../src/config'
import {
	ArtifactValidationError,
	assertAllowedArtifactUrl,
	validateArtifact,
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

type FixtureEntry = {
	name: string
	data: string | Uint8Array
	password?: string
}

async function zip(entries: FixtureEntry[], level = 0) {
	const writer = new ZipWriter(new Uint8ArrayWriter(), {
		level,
		useWebWorkers: false,
	})
	for (const entry of entries) {
		await writer.add(
			entry.name,
			new Uint8ArrayReader(
				typeof entry.data === 'string'
					? new TextEncoder().encode(entry.data)
					: entry.data,
			),
			{ password: entry.password },
		)
	}
	return writer.close()
}

function manifest(type = 'data') {
	return JSON.stringify({
		format_version: 2,
		header: {
			name: 'Test pack',
			uuid: 'd325699c-a583-4bc4-8b9b-1fa8ef81c022',
			version: [1, 0, 0],
			min_engine_version: [1, 21, 0],
		},
		modules: [
			{
				type,
				uuid: '0830a2d2-af2b-4cc9-aeeb-48f8c8406506',
				version: [1, 0, 0],
			},
		],
	})
}

async function withStorage<T>(
	bytes: Uint8Array,
	operation: () => Promise<T>,
	onWholeFileRead?: (init?: RequestInit) => Promise<Response> | undefined,
) {
	// Exercise the real ZIP/HTTP range reader, with a deterministic storage response.
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(
		async (_url, init) => {
			const range = new Headers(init?.headers).get('range')
			const headers = {
				'Accept-Ranges': 'bytes',
				'Content-Length': String(bytes.length),
			}
			if (init?.method === 'HEAD') return new Response(null, { headers })
			if (!range) {
				const override = await onWholeFileRead?.(init)
				return override ?? new Response(bytes.slice(), { headers })
			}
			const match = /^bytes=(\d*)-(\d*)$/.exec(range)
			if (!match) return new Response(null, { status: 416 })
			const start = match[1]
				? Number(match[1])
				: Math.max(0, bytes.length - Number(match[2]))
			const end =
				match[1] && match[2]
					? Math.min(bytes.length - 1, Number(match[2]))
					: bytes.length - 1
			if (start >= bytes.length) return new Response(null, { status: 416 })
			return new Response(bytes.slice(start, end + 1), {
				status: 206,
				headers: {
					...headers,
					'Content-Length': String(end - start + 1),
					'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
				},
			})
		},
	)
	try {
		return await operation()
	} finally {
		fetch.mockRestore()
	}
}

function validateZip(
	bytes: Uint8Array,
	type: 'addon' | 'resource_pack' = 'addon',
) {
	return withStorage(bytes, () =>
		validateArtifact(
			{
				type,
				fileName: type === 'addon' ? 'test.mcaddon' : 'test.mcpack',
				fileSize: bytes.length,
				downloadUrl: 'https://storage.example.test/test',
			},
			config.artifactAllowedHosts,
		),
	)
}

describe('artifact checksums', () => {
	async function bundledAddon() {
		return new Uint8Array(
			await Bun.file(
				new URL('./fixtures/nexus-dev-smoke-bundled.mcaddon', import.meta.url),
			).arrayBuffer(),
		)
	}

	function request(bytes: Uint8Array, fileSize = bytes.length) {
		return validateArtifact(
			{
				downloadUrl: 'https://storage.example.test/test',
				fileName: 'test.mcaddon',
				fileSize,
				type: 'addon',
			},
			config.artifactAllowedHosts,
		)
	}

	test('reports the SHA-256 of the whole file', async () => {
		const bytes = await bundledAddon()
		const expected = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

		const result = await validateZip(bytes)

		expect(result).toMatchObject({ report: { sha256: expected }, valid: true })
	})

	test('rejects a file larger than declared', async () => {
		const bytes = await bundledAddon()

		const result = await withStorage(bytes, () =>
			request(bytes, bytes.length - 1),
		)

		expect(result).toMatchObject({ code: 'INVALID_FILE_SIZE', valid: false })
	})

	test('rejects a file smaller than declared', async () => {
		const bytes = await bundledAddon()

		const result = await withStorage(bytes, () =>
			request(bytes, bytes.length + 1),
		)

		expect(result).toMatchObject({ code: 'INVALID_FILE_SIZE', valid: false })
	})

	test.each([
		[
			'the connection fails',
			() => Promise.reject(new Error('connection reset')),
		],
		[
			'storage answers with an error',
			() => Promise.resolve(new Response(null, { status: 500 })),
		],
	])(
		'treats it as temporary when %s, so the upload is kept',
		async (_label, fail) => {
			const bytes = await bundledAddon()

			const result = await withStorage(bytes, () => request(bytes), fail)

			expect(result).toMatchObject({
				code: 'VALIDATOR_UNAVAILABLE',
				valid: false,
			})
		},
	)

	test('does not follow redirects when hashing', async () => {
		const bytes = await bundledAddon()
		const redirects: Array<RequestInit['redirect']> = []

		await withStorage(
			bytes,
			() => request(bytes),
			(init) => {
				redirects.push(init?.redirect)
				return undefined
			},
		)

		expect(redirects).toEqual(['error'])
	})
})

describe('pack archives', () => {
	test('validates the exact 636-byte bundled addon rejected by the live validator', async () => {
		const bytes = new Uint8Array(
			await Bun.file(
				new URL('./fixtures/nexus-dev-smoke-bundled.mcaddon', import.meta.url),
			).arrayBuffer(),
		)
		expect(bytes.length).toBe(636)
		const result = await validateZip(bytes)
		expect(result).toMatchObject({
			valid: true,
			report: { type: 'addon', entryCount: 3, manifestCount: 1 },
		})
	})

	test('validates behavior and resource packs in one bundle', async () => {
		const behavior = await zip([
			{ name: 'manifest.json', data: manifest() },
			{ name: 'functions/test.mcfunction', data: 'say test' },
		])
		const resources = await zip([
			{ name: 'manifest.json', data: manifest('resources') },
		])
		const bundle = await zip([
			{ name: 'behavior.mcpack', data: behavior },
			{ name: 'resource.mcpack', data: resources },
		])
		expect(await validateZip(bundle)).toMatchObject({
			valid: true,
			report: {
				entryCount: 5,
				manifestCount: 2,
				totalUncompressedSize:
					behavior.length +
					resources.length +
					manifest().length +
					'say test'.length +
					manifest('resources').length,
			},
		})
	})

	test('preserves unpacked addon and direct resource-pack validation', async () => {
		expect(
			await validateZip(
				await zip([{ name: 'bp/manifest.json', data: manifest() }]),
			),
		).toMatchObject({ valid: true, report: { manifestCount: 1 } })
		expect(
			await validateZip(
				await zip([{ name: 'manifest.json', data: manifest('resources') }]),
				'resource_pack',
			),
		).toMatchObject({ valid: true })
		expect(
			await validateZip(
				await zip([{ name: 'manifest.json', data: manifest() }]),
				'resource_pack',
			),
		).toMatchObject({ valid: false, code: 'INVALID_PACK_TYPE' })
	})

	test.each([
		[
			'unsafe paths',
			[
				{ name: '../escape.json', data: '{}' },
				{ name: 'manifest.json', data: manifest() },
			],
			'INVALID_ARCHIVE',
		],
		[
			'duplicate paths',
			[
				{ name: 'manifest.json', data: manifest() },
				{ name: 'MANIFEST.JSON', data: manifest() },
			],
			'DUPLICATE_ARCHIVE_PATH',
		],
		[
			'encrypted entries',
			[{ name: 'manifest.json', data: manifest(), password: 'test-password' }],
			'ENCRYPTED_ARCHIVE',
		],
		[
			'missing manifest',
			[{ name: 'readme.txt', data: 'no pack' }],
			'MISSING_MANIFEST',
		],
		[
			'malformed JSON',
			[{ name: 'manifest.json', data: '{' }],
			'INVALID_MANIFEST',
		],
		[
			'non-object manifest',
			[{ name: 'manifest.json', data: 'null' }],
			'INVALID_MANIFEST',
		],
		[
			'unsupported modules',
			[{ name: 'manifest.json', data: manifest('skin_pack') }],
			'INVALID_PACK_TYPE',
		],
	] as const)(
		'rejects %s inside a bundled pack',
		async (_label, entries, code) => {
			const pack = await zip([...entries])
			expect(
				await validateZip(await zip([{ name: 'pack.mcpack', data: pack }])),
			).toMatchObject({ valid: false, code })
		},
	)

	test('does not let an outer manifest hide a malformed bundled pack', async () => {
		const bundle = await zip([
			{ name: 'bp/manifest.json', data: manifest() },
			{ name: 'bad.mcpack', data: 'not a ZIP' },
		])
		expect(await validateZip(bundle)).toMatchObject({
			valid: false,
			code: 'INVALID_ARCHIVE',
		})
	})

	test('rejects recursive bundles and nested resource-pack uploads', async () => {
		const pack = await zip([{ name: 'manifest.json', data: manifest() }])
		const recursive = await zip([
			{ name: 'manifest.json', data: manifest() },
			{ name: 'inner.mcpack', data: pack },
		])
		expect(
			await validateZip(await zip([{ name: 'outer.mcpack', data: recursive }])),
		).toMatchObject({ valid: false, code: 'NESTED_PACK_DEPTH' })
		expect(
			await validateZip(
				await zip([
					{ name: 'manifest.json', data: manifest('resources') },
					{ name: 'pack.mcpack', data: pack },
				]),
				'resource_pack',
			),
		).toMatchObject({ valid: false, code: 'NESTED_PACK_DEPTH' })
	})

	test('applies the entry limit across all packs, not separately to each', async () => {
		const pack = await zip([
			{ name: 'manifest.json', data: manifest() },
			...Array.from({ length: 2500 }, (_, i) => ({
				name: `items/${i}.json`,
				data: '{}',
			})),
		])
		const bundle = await zip(
			Array.from({ length: 4 }, (_, i) => ({
				name: `${i}.mcpack`,
				data: pack,
			})),
		)
		expect(await validateZip(bundle)).toMatchObject({
			valid: false,
			code: 'INVALID_ENTRY_COUNT',
		})
	}, 60_000)

	test('rejects too many embedded packs before extracting them', async () => {
		const bundle = await zip(
			Array.from({ length: 65 }, (_, i) => ({
				name: `${i}.mcpack`,
				data: 'not extracted',
			})),
		)
		expect(await validateZip(bundle)).toMatchObject({
			valid: false,
			code: 'INVALID_ENTRY_COUNT',
		})
	})

	test('rejects unsafe expansion inside embedded packs', async () => {
		const pack = await zip(
			[
				{ name: 'manifest.json', data: manifest() },
				{ name: 'data.bin', data: new Uint8Array(1024 * 1024) },
			],
			9,
		)
		expect(
			await validateZip(await zip([{ name: 'bomb.mcpack', data: pack }])),
		).toMatchObject({ valid: false, code: 'UNSAFE_EXPANSION_RATIO' })
	})

	test('bounds cumulative expansion even when each archive separately stays within its limit', async () => {
		let seed = 123456
		const noise = Uint8Array.from({ length: 128 }, () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return seed >>> 24
		})
		const pack = await zip([
			{
				name: 'manifest.json',
				data: '{"header":{},"modules":[{"type":"data"}]}',
			},
			{ name: 'zeros.dat', data: new Uint8Array(65536) },
			{ name: 'noise.dat', data: noise },
		])
		const bundle = await zip([{ name: 'pack.mcpack', data: pack }], 9)
		const reader = new ZipReader(new Uint8ArrayReader(bundle))
		try {
			const [entry] = await reader.getEntries()
			expect(pack.length / entry.compressedSize).toBeLessThan(200)
		} finally {
			await reader.close()
		}
		expect(await validateZip(bundle)).toMatchObject({
			valid: false,
			code: 'UNSAFE_EXPANSION_RATIO',
		})
	})

	test('returns a retryable HTTP error for unavailable temporary storage', async () => {
		const pack = await zip([{ name: 'manifest.json', data: manifest() }])
		const bundle = await zip([{ name: 'pack.mcpack', data: pack }])
		const keys = ['TMPDIR', 'TEMP', 'TMP'] as const
		const previous = keys.map((key) => process.env[key])
		const missingDirectory = join(
			tmpdir(),
			`nexus-unavailable-${crypto.randomUUID()}`,
		)
		try {
			for (const key of keys) process.env[key] = missingDirectory
			await withStorage(bundle, async () => {
				const response = await createWorkerApp(config).request(
					'/artifact-validate',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'X-API-Key': 'test-secret',
						},
						body: JSON.stringify({
							type: 'addon',
							fileName: 'test.mcaddon',
							fileSize: bundle.length,
							downloadUrl: 'https://storage.example.test/test',
						}),
					},
				)
				expect(response.status).toBe(503)
				expect(await response.json()).toMatchObject({
					valid: false,
					code: 'VALIDATOR_UNAVAILABLE',
				})
			})
		} finally {
			for (const [index, key] of keys.entries()) {
				if (previous[index] === undefined) delete process.env[key]
				else process.env[key] = previous[index]
			}
		}
	})

	test('cleans up temporary pack files after successful and rejected validation', async () => {
		const before = (await readdir(tmpdir()))
			.filter((name) => name.startsWith('bedrocknexus-pack-'))
			.sort()
		await validateZip(
			await zip([
				{
					name: 'good.mcpack',
					data: await zip([{ name: 'manifest.json', data: manifest() }]),
				},
			]),
		)
		await validateZip(await zip([{ name: 'bad.mcpack', data: 'not a ZIP' }]))
		expect(
			(await readdir(tmpdir()))
				.filter((name) => name.startsWith('bedrocknexus-pack-'))
				.sort(),
		).toEqual(before)
	})
})

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
