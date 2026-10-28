import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { validateRemoteMap } from '../src/lib/remote-map-validator'
import { createArtifactValidationRoutes } from '../src/routes/artifact-validate'

const etag = '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
const fixture = new Uint8Array(
	await Bun.file(
		new URL('./fixtures/maps/SampleParkourWorld.mcworld', import.meta.url),
	).arrayBuffer(),
)
const request = {
	fileName: 'world.mcworld',
	fileSize: fixture.length,
	downloadUrl: 'https://storage.example/world',
	sourceEtag: etag,
}
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined
afterEach(() => fetchMock?.mockRestore())
function storage(
	bytes = fixture,
	status = 200,
	headers: Record<string, string> = {},
) {
	fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
		async () =>
			new Response(bytes.slice(), {
				status,
				headers: { etag, 'content-length': String(bytes.length), ...headers },
			}),
	)
}
test('downloads one pinned object with no redirects and hashes the exact validated snapshot', async () => {
	storage()
	expect(await validateRemoteMap(request, ['storage.example'])).toMatchObject({
		valid: true,
		report: {
			sha256: createHash('sha256').update(fixture).digest('hex'),
			sourceEtag: etag,
			fileSize: fixture.length,
		},
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
	expect(fetchMock?.mock.calls[0]?.[1]).toMatchObject({
		headers: { 'If-Match': etag },
		redirect: 'error',
		credentials: 'omit',
	})
})
test.each([
	[
		'changed ETag',
		200,
		{ etag: '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' },
		'ARTIFACT_IDENTITY_MISMATCH',
	],
	['precondition failed', 412, {}, 'ARTIFACT_IDENTITY_MISMATCH'],
	['wrong size', 200, { 'content-length': '1' }, 'INVALID_FILE_SIZE'],
	['encoded content', 200, { 'content-encoding': 'gzip' }, 'INVALID_FILE_SIZE'],
	['unavailable', 503, {}, 'VALIDATOR_UNAVAILABLE'],
	['redirect response', 302, {}, 'VALIDATOR_UNAVAILABLE'],
] as const)('rejects %s', async (_name, status, headers, code) => {
	storage(fixture, status, headers)
	expect(await validateRemoteMap(request, ['storage.example'])).toMatchObject({
		valid: false,
		code,
	})
})
test('checks actual body length independently of Content-Length', async () => {
	storage(fixture.subarray(0, 10), 200, {
		'content-length': String(fixture.length),
	})
	expect(await validateRemoteMap(request, ['storage.example'])).toMatchObject({
		valid: false,
		code: 'INVALID_FILE_SIZE',
	})
	fetchMock?.mockRestore()
	storage(fixture, 200, { 'content-length': '10' })
	expect(
		await validateRemoteMap({ ...request, fileSize: 10 }, ['storage.example']),
	).toMatchObject({ valid: false, code: 'INVALID_FILE_SIZE' })
})
test('validates URLs, ETags and size before fetching', async () => {
	storage()
	for (const change of [
		{ downloadUrl: 'https://evil.example/world' },
		{ sourceEtag: 'W/"abc"' },
		{ fileSize: Number.NaN },
		{ fileSize: 513 * 1024 * 1024 },
	])
		expect(
			(await validateRemoteMap({ ...request, ...change }, ['storage.example']))
				.valid,
		).toBe(false)
	expect(fetchMock).not.toHaveBeenCalled()
})
test('keeps the Maps endpoint authenticated and disabled by default', async () => {
	const disabled = createArtifactValidationRoutes({
		apiKey: 'secret',
		allowedHosts: ['storage.example'],
	})
	expect((await disabled.request('/maps', { method: 'POST' })).status).toBe(401)
	expect(
		(
			await disabled.request('/maps', {
				method: 'POST',
				headers: { 'X-API-Key': 'secret' },
			})
		).status,
	).toBe(404)
	storage()
	const enabled = createArtifactValidationRoutes({
		apiKey: 'secret',
		allowedHosts: ['storage.example'],
		enableMaps: true,
	})
	const response = await enabled.request('/maps', {
		method: 'POST',
		headers: { 'X-API-Key': 'secret', 'Content-Type': 'application/json' },
		body: JSON.stringify({ type: 'map', ...request }),
	})
	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({ valid: true })
})
