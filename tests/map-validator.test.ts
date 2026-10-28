import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { validateMapBytes, validateMapFile } from '../src/lib/map-validator'
import {
	MAP_METADATA_LIMITS,
	readMapWorldMetadata,
} from '../src/lib/map-world-metadata'
import { createWorkerApp } from '../src/worker-app'

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const moduleId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const resourceId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const resourceModule = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
function text(value: string) {
	const bytes = Buffer.from(value)
	const length = Buffer.alloc(2)
	length.writeUInt16LE(bytes.length)
	return Buffer.concat([length, bytes])
}
function tag(type: number, name: string, payload: Uint8Array) {
	return Buffer.concat([Buffer.from([type]), text(name), payload])
}
function level(payload: Uint8Array = Buffer.from([0]), storageVersion = 9) {
	const root = Buffer.concat([Buffer.from([10, 0, 0]), payload])
	const header = Buffer.alloc(8)
	header.writeUInt32LE(storageVersion)
	header.writeUInt32LE(root.length, 4)
	return Buffer.concat([header, root])
}
type Entry = {
	name: string
	data: string | Uint8Array
	unixMode?: number
	password?: string
}
async function zip(entries: Entry[], compression = 0) {
	const writer = new ZipWriter(new Uint8ArrayWriter(), {
		level: compression,
		useWebWorkers: false,
	})
	for (const entry of entries)
		await writer.add(
			entry.name,
			new Uint8ArrayReader(
				typeof entry.data === 'string' ? Buffer.from(entry.data) : entry.data,
			),
			{ unixMode: entry.unixMode, password: entry.password },
		)
	return writer.close()
}
const vanilla = (): Entry[] => [
	{ name: 'level.dat', data: level() },
	{ name: 'db/000001.log', data: 'world data fixture, not a real LevelDB' },
]
function manifest(kind = 'data', packId = id, modId = moduleId) {
	return {
		format_version: 2,
		header: {
			name: 'Test',
			uuid: packId,
			version: [1, 0, 0],
			min_engine_version: [1, 21, 0],
		},
		modules: [{ type: kind, uuid: modId, version: [1, 0, 0] }],
	}
}
const refs = (uuid = id, version = [1, 0, 0]) =>
	JSON.stringify([{ pack_id: uuid, version }])
async function check(entries: Entry[], compression = 0) {
	return validateMapBytes(await zip(entries, compression), 'test.mcworld')
}

describe('offline map validation', () => {
	test('file-backed evaluation matches byte validation, preserves source files and cleans snapshots', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'nexus-map-source-test-'))
		const path = join(directory, 'world.mcworld')
		const before = new Set(
			(await readdir(tmpdir())).filter((name) =>
				name.startsWith('bedrocknexus-world-'),
			),
		)
		try {
			const bytes = await zip(vanilla())
			await Bun.write(path, bytes)
			expect(await validateMapFile(path)).toEqual(
				await validateMapBytes(bytes, 'world.mcworld'),
			)
			expect(new Uint8Array(await readFile(path))).toEqual(bytes)
			await Bun.write(path, 'malformed archive')
			expect(await validateMapFile(path)).toMatchObject({
				valid: false,
				code: 'INVALID_ARCHIVE',
			})
			expect(await readFile(path, 'utf8')).toBe('malformed archive')
			expect(
				(await readdir(tmpdir())).filter(
					(name) => name.startsWith('bedrocknexus-world-') && !before.has(name),
				),
			).toEqual([])
		} finally {
			await rm(path, { force: true })
			await rmdir(directory)
		}
	})
	test('validates the unmodified pinned Microsoft parkour world and its hash', async () => {
		const bytes = new Uint8Array(
			await Bun.file(
				new URL('./fixtures/maps/SampleParkourWorld.mcworld', import.meta.url),
			).arrayBuffer(),
		)
		expect(
			await validateMapBytes(bytes, 'SampleParkourWorld.mcworld'),
		).toMatchObject({
			valid: true,
			report: {
				fileSize: 53915,
				sha256:
					'77d9f2cc2288fc4ba6fedae4ae16221bfe024fa3f35c8dac03129cae5720c9d9',
				entryCount: 8,
				totalUncompressedSize: 63390,
				world: { storageVersion: 9, commandBlocksEnabled: true },
				packs: [],
			},
		})
	})
	test('validates the pinned official-source world with real behavior/resource/script packs', async () => {
		const result = await validateMapBytes(
			new Uint8Array(
				await Bun.file(
					new URL(
						'./fixtures/maps/OfficialPackedSource.mcworld',
						import.meta.url,
					),
				).arrayBuffer(),
			),
			'OfficialPackedSource.mcworld',
		)
		expect(result).toMatchObject({
			valid: true,
			report: {
				fileSize: 577562,
				sha256:
					'4967b466a0db7862107aa520db5ccce9bc4596ea6ea9fe327500611bf64ed406',
				entryCount: 60,
				totalUncompressedSize: 629808,
				warnings: [],
				packs: [
					{
						kind: 'behavior',
						uuid: '4dff1106-b6f7-4f3b-aca3-79c45133285b',
						moduleTypes: ['data', 'script'],
						scriptEntries: ['scripts/main.js'],
						dependencies: [
							{
								uuid: 'bc234388-0691-40a4-89bd-e783a5c90830',
								version: [1, 0, 0],
							},
						],
						engineDependencies: [
							{ moduleName: '@minecraft/server', version: '1.8.0' },
							{ moduleName: '@minecraft/server-ui', version: '1.1.0' },
						],
					},
					{
						kind: 'resource',
						uuid: 'bc234388-0691-40a4-89bd-e783a5c90830',
						dependencies: [
							{
								uuid: '4dff1106-b6f7-4f3b-aca3-79c45133285b',
								version: [1, 0, 0],
							},
						],
					},
				],
			},
		})
	})
	test('allows log-only synthetic world structure with optional metadata and no pack manifest', async () => {
		expect(
			await check([
				...vanilla(),
				{ name: 'levelname.txt', data: 'Example' },
				{ name: 'level.dat_old', data: 'opaque backup' },
			]),
		).toMatchObject({ valid: true, report: { packs: [], warnings: [] } })
	})
	test.each([
		[
			'missing level',
			[{ name: 'db/1.log', data: 'x' }],
			'MISSING_WORLD_METADATA',
		],
		[
			'missing DB',
			[{ name: 'level.dat', data: level() }],
			'MISSING_WORLD_DATA',
		],
		[
			'empty DB',
			[
				{ name: 'level.dat', data: level() },
				{ name: 'db/1.log', data: '' },
			],
			'MISSING_WORLD_DATA',
		],
		[
			'wrapped world',
			vanilla().map((entry) => ({ ...entry, name: `world/${entry.name}` })),
			'AMBIGUOUS_WORLD_ROOT',
		],
		[
			'multiple worlds',
			[...vanilla(), { name: 'other/level.dat', data: level() }],
			'AMBIGUOUS_WORLD_ROOT',
		],
		[
			'Java layout',
			[...vanilla(), { name: 'region/r.0.0.mca', data: 'java' }],
			'UNSUPPORTED_WORLD_FORMAT',
		],
		[
			'template manifest',
			[
				...vanilla(),
				{
					name: 'manifest.json',
					data: JSON.stringify(manifest('world_template')),
				},
			],
			'UNSUPPORTED_WORLD_FORMAT',
		],
		[
			'nested pack',
			[...vanilla(), { name: 'behavior.mcpack', data: 'nested' }],
			'UNSUPPORTED_NESTED_ARCHIVE',
		],
		[
			'dot alias',
			[...vanilla(), { name: 'foo/./bar', data: 'x' }],
			'INVALID_ARCHIVE',
		],
		[
			'Windows alias',
			[...vanilla(), { name: 'db/con.txt', data: 'x' }],
			'UNSAFE_ARCHIVE_PATH',
		],
		[
			'trailing space',
			[...vanilla(), { name: 'foo /bar', data: 'x' }],
			'UNSAFE_ARCHIVE_PATH',
		],
		[
			'case collision',
			[...vanilla(), { name: 'LEVEL.DAT', data: level() }],
			'DUPLICATE_ARCHIVE_PATH',
		],
		[
			'Unicode collision',
			[
				...vanilla(),
				{ name: 'café', data: 'x' },
				{ name: 'cafe\u0301', data: 'x' },
			],
			'DUPLICATE_ARCHIVE_PATH',
		],
		[
			'file/dir collision',
			[...vanilla(), { name: 'db', data: 'x' }],
			'DUPLICATE_ARCHIVE_PATH',
		],
		[
			'symlink',
			[...vanilla(), { name: 'link', data: '../outside', unixMode: 0o120777 }],
			'UNSAFE_ARCHIVE_PATH',
		],
		[
			'device file',
			[...vanilla(), { name: 'device', data: '', unixMode: 0o020666 }],
			'UNSAFE_ARCHIVE_PATH',
		],
		[
			'encrypted',
			[...vanilla(), { name: 'secret', data: 'x', password: 'test' }],
			'ENCRYPTED_ARCHIVE',
		],
		[
			'broken level',
			[{ name: 'level.dat', data: 'broken' }, vanilla()[1]],
			'INVALID_WORLD_METADATA',
		],
		[
			'unsupported level',
			[{ name: 'level.dat', data: level(undefined, 99) }, vanilla()[1]],
			'UNSUPPORTED_WORLD_FORMAT',
		],
		[
			'null activation',
			[...vanilla(), { name: 'world_behavior_packs.json', data: 'null' }],
			'INVALID_WORLD_PACK_REFERENCES',
		],
		[
			'object activation',
			[...vanilla(), { name: 'world_resource_packs.json', data: '{}' }],
			'INVALID_WORLD_PACK_REFERENCES',
		],
		[
			'invalid activation JSON',
			[...vanilla(), { name: 'world_resource_packs.json', data: '{' }],
			'INVALID_WORLD_PACK_REFERENCES',
		],
		[
			'missing activated pack',
			[...vanilla(), { name: 'world_behavior_packs.json', data: refs() }],
			'UNRESOLVED_PACK_DEPENDENCY',
		],
		[
			'missing bundled manifest',
			[...vanilla(), { name: 'behavior_packs/bp/data.json', data: '{}' }],
			'MISSING_MANIFEST',
		],
	] satisfies [string, Entry[], string][])(
		'rejects %s',
		async (_name, entries, code) => {
			expect(await check(entries)).toMatchObject({ valid: false, code })
		},
	)
	test('verifies CRC of ordinary database data, not just metadata', async () => {
		const bytes = await zip(vanilla())
		const position = Buffer.from(bytes).indexOf('world data fixture')
		expect(position).toBeGreaterThan(0)
		bytes[position] ^= 1
		expect(await validateMapBytes(bytes, 'test.mcworld')).toMatchObject({
			valid: false,
			code: 'INVALID_ARCHIVE',
		})
	})
	test.each([
		'WORLD_BEHAVIOR_PACKS.JSON',
		'World_resource_packs.json',
		'Manifest.json',
		'Behavior_Packs/bp/manifest.json',
		'resource_Packs/rp/manifest.json',
		'behavior_packs/bp/Manifest.json',
		'resource_packs/rp/MANIFEST.JSON',
		'\uff42ehavior_packs/bp/manifest.json',
	])(
		'rejects pack metadata aliases that could hide inventory: %s',
		async (name) => {
			expect(await check([...vanilla(), { name, data: '{}' }])).toMatchObject({
				valid: false,
				code: 'UNSAFE_ARCHIVE_PATH',
			})
		},
	)
	test('preserves creator-chosen casing inside a canonical bundled-pack folder', async () => {
		expect(
			await check([
				...vanilla(),
				{
					name: 'behavior_packs/MyPack/manifest.json',
					data: JSON.stringify(manifest()),
				},
				{ name: 'world_behavior_packs.json', data: refs() },
			]),
		).toMatchObject({
			valid: true,
			report: { packs: [{ path: 'behavior_packs/MyPack' }], warnings: [] },
		})
	})
	test.each(['behavior_packs', 'resource_packs', 'mixed'])(
		'rejects excess %s inventories before reading malformed metadata',
		async (directory) => {
			const entries = Array.from({ length: 65 }, (_, index) => ({
				name: `${directory === 'mixed' ? (index % 2 ? 'behavior_packs' : 'resource_packs') : directory}/pack${index}/manifest.json`,
				data: '{malformed JSON that must never be parsed',
			}))
			expect(await check([...vanilla(), ...entries])).toMatchObject({
				valid: false,
				code: 'INVALID_ENTRY_COUNT',
			})
			// At the boundary, proceed to normal metadata validation.
			expect(
				await check([...vanilla(), ...entries.slice(0, 64)]),
			).toMatchObject({
				valid: false,
				code: 'INVALID_MANIFEST',
			})
		},
	)
	test('rejects excess inventories before decompressing corrupt database contents', async () => {
		const bytes = await zip([
			...vanilla(),
			...Array.from({ length: 65 }, (_, index) => ({
				name: `behavior_packs/pack${index}/data.json`,
				data: '{}',
			})),
		])
		const position = Buffer.from(bytes).indexOf('world data fixture')
		expect(position).toBeGreaterThan(0)
		bytes[position] ^= 1
		expect(await validateMapBytes(bytes, 'test.mcworld')).toMatchObject({
			valid: false,
			code: 'INVALID_ENTRY_COUNT',
		})
	})
	test('validates a stable snapshot if the caller mutates the input during reads', async () => {
		const bytes = await zip(vanilla())
		const result = validateMapBytes(bytes, 'test.mcworld')
		bytes.fill(0)
		expect(await result).toMatchObject({ valid: true })
	})
	test('rejects unsafe expansion', async () => {
		expect(
			await check(
				[
					...vanilla(),
					{ name: 'large.txt', data: '0'.repeat(2 * 1024 * 1024) },
				],
				9,
			),
		).toMatchObject({ valid: false, code: 'UNSAFE_EXPANSION_RATIO' })
	})
	test('validates active behavior/resource inventories and cross-pack UUID dependencies', async () => {
		const behavior = {
			...manifest(),
			dependencies: [{ uuid: resourceId, version: [1, 0, 0] }],
		}
		expect(
			await check([
				...vanilla(),
				{
					name: 'behavior_packs/bp/manifest.json',
					data: JSON.stringify(behavior),
				},
				{
					name: 'resource_packs/rp/manifest.json',
					data: JSON.stringify(
						manifest('resources', resourceId, resourceModule),
					),
				},
				{ name: 'world_behavior_packs.json', data: refs() },
				{ name: 'world_resource_packs.json', data: refs(resourceId) },
			]),
		).toMatchObject({
			valid: true,
			report: {
				warnings: [],
				packs: [
					{ kind: 'behavior', uuid: id },
					{ kind: 'resource', uuid: resourceId },
				],
			},
		})
	})
	test('reports inactive packs separately', async () => {
		expect(
			await check([
				...vanilla(),
				{
					name: 'behavior_packs/bp/manifest.json',
					data: JSON.stringify(manifest()),
				},
			]),
		).toMatchObject({
			valid: true,
			report: {
				warnings: [
					{ code: 'INACTIVE_BUNDLED_PACK', path: 'behavior_packs/bp' },
				],
			},
		})
	})
	test.each([
		[
			'version mismatch',
			manifest(),
			refs(id, [2, 0, 0]),
			'UNRESOLVED_PACK_DEPENDENCY',
		],
		['module type mismatch', manifest('resources'), refs(), 'INVALID_MANIFEST'],
		[
			'unknown manifest',
			{ ...manifest(), format_version: 3 },
			refs(),
			'UNSUPPORTED_WORLD_FORMAT',
		],
		[
			'duplicate module id',
			manifest('data', id, id),
			refs(),
			'INVALID_MANIFEST',
		],
		[
			'missing dependency',
			{
				...manifest(),
				dependencies: [{ uuid: resourceId, version: [1, 0, 0] }],
			},
			refs(),
			'UNRESOLVED_PACK_DEPENDENCY',
		],
		[
			'duplicate activation',
			manifest(),
			JSON.stringify([...JSON.parse(refs()), ...JSON.parse(refs())]),
			'INVALID_WORLD_PACK_REFERENCES',
		],
	])('rejects pack %s', async (_name, data, activation, code) => {
		expect(
			await check([
				...vanilla(),
				{ name: 'behavior_packs/bp/manifest.json', data: JSON.stringify(data) },
				{ name: 'world_behavior_packs.json', data: activation },
			]),
		).toMatchObject({ valid: false, code })
	})
	test('requires script entry files and distinguishes engine module dependencies', async () => {
		const data = {
			...manifest('script'),
			modules: [
				{
					...manifest('script').modules[0],
					language: 'javascript',
					entry: 'scripts/main.js',
				},
			],
			dependencies: [{ module_name: '@minecraft/server', version: '1.9.0' }],
		}
		const entries = [
			...vanilla(),
			{ name: 'behavior_packs/bp/manifest.json', data: JSON.stringify(data) },
		]
		expect(await check(entries)).toMatchObject({
			valid: false,
			code: 'INVALID_MANIFEST',
		})
		expect(
			await check([
				...entries,
				{
					name: 'behavior_packs/bp/scripts/main.js',
					data: 'throw new Error("NEVER EXECUTE")',
				},
			]),
		).toMatchObject({
			valid: true,
			report: {
				packs: [
					{
						engineDependencies: [
							{ moduleName: '@minecraft/server', version: '1.9.0' },
						],
					},
				],
			},
		})
	})
	test('rejects incorrect file extension and nonarchive bytes', async () => {
		expect(
			await validateMapBytes(await zip(vanilla()), 'test.zip'),
		).toMatchObject({ valid: false, code: 'INVALID_EXTENSION' })
		expect(
			await validateMapBytes(Buffer.from('not a zip'), 'test.mcworld'),
		).toMatchObject({ valid: false, code: 'INVALID_ARCHIVE' })
	})
	test('does not expose Maps through the existing HTTP validator', async () => {
		const app = createWorkerApp({
			apiKey: 'test',
			artifactAllowedHosts: [],
			corsOrigins: '*',
			generalRateLimit: 10,
			maxConcurrentStatusChecks: 2,
			maxQueuedStatusChecks: 2,
			statusRateLimit: 2,
			trustProxyHeaders: false,
		})
		const result = await app.request('/artifact-validate', {
			method: 'POST',
			headers: { 'X-API-Key': 'test', 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'map',
				fileName: 'test.mcworld',
				fileSize: 10,
				downloadUrl: 'https://storage.example/test',
			}),
		})
		expect(result.status).toBe(400)
	})
})

describe('bounded Bedrock metadata parser', () => {
	test('returns only allowlisted settings and preserves unknown values', () => {
		const data = level(
			Buffer.concat([
				tag(1, 'commandblocksenabled', Buffer.from([0])),
				tag(1, 'commandsEnabled', Buffer.from([1])),
				tag(8, 'LevelName', text('Private world name')),
				tag(4, 'RandomSeed', Buffer.alloc(8)),
				Buffer.from([0]),
			]),
		)
		expect(readMapWorldMetadata(data)).toEqual({
			storageVersion: 9,
			commandBlocksEnabled: false,
			commandsEnabled: true,
		})
		expect(readMapWorldMetadata(level())).toEqual({ storageVersion: 9 })
	})
	test('rejects duplicate tags, invalid tag types and trailing payload bytes', () => {
		for (const payload of [
			Buffer.concat([
				tag(1, 'x', Buffer.from([1])),
				tag(1, 'x', Buffer.from([1])),
				Buffer.from([0]),
			]),
			tag(99, 'bad', Buffer.from([0])),
			Buffer.from([0, 0]),
		])
			expect(() => readMapWorldMetadata(level(payload))).toThrow()
	})
	test('rejects invalid lengths, excessive nesting and oversized payloads', () => {
		const invalidLength = Buffer.alloc(4)
		invalidLength.writeInt32LE(-1)
		expect(() =>
			readMapWorldMetadata(
				level(Buffer.concat([tag(7, 'bad', invalidLength), Buffer.from([0])])),
			),
		).toThrow()
		let nested: Buffer = Buffer.from([0])
		for (let i = 0; i < 40; i++)
			nested = Buffer.concat([tag(10, 'nested', nested), Buffer.from([0])])
		expect(() => readMapWorldMetadata(level(nested))).toThrow()
		expect(() =>
			readMapWorldMetadata(new Uint8Array(MAP_METADATA_LIMITS.bytes + 1)),
		).toThrow()
		const badHeader = level()
		badHeader[4] = 255
		expect(() => readMapWorldMetadata(badHeader)).toThrow()
	})
})
