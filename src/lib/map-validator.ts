import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
	BlobReader,
	type Entry,
	Uint8ArrayReader,
	ZipReader,
} from '@zip.js/zip.js'
import {
	type MapBundledPack,
	packReferenceKey,
	readMapPackManifest,
	readMapPackReferences,
} from './map-pack-inventory'
import {
	MAP_METADATA_LIMITS,
	MapValidationError,
	type MapWorldObservations,
	readMapWorldMetadata,
} from './map-world-metadata'

/** Evaluation limits only; remote Maps validation is separately gated. */
export const MAP_EVALUATION_POLICY = {
	version: 'maps-evaluation-1',
	compressedBytes: 256 * 1024 * 1024,
	fileBackedCompressedBytes: 512 * 1024 * 1024,
	expandedBytes: 4 * 1024 * 1024 * 1024,
	entries: 10_000,
	expansionRatio: 200,
	jsonBytes: 1024 * 1024,
	packs: 64,
	reportBytes: 64 * 1024,
} as const

export interface MapEvaluationReport {
	type: 'map'
	schemaVersion: 1
	validatorVersion: 'maps-offline-1'
	policyVersion: typeof MAP_EVALUATION_POLICY.version
	fileSize: number
	sha256: string
	entryCount: number
	totalUncompressedSize: number
	world: MapWorldObservations
	packs: MapBundledPack[]
	warnings: { code: 'INACTIVE_BUNDLED_PACK'; path: string }[]
}
export type MapEvaluationResult =
	| { valid: true; report: MapEvaluationReport }
	| { valid: false; code: string; error: string }

function fail(code: string, message: string): never {
	throw new MapValidationError(code, message)
}

function checkedPath(entry: Entry) {
	const name = entry.filename
	if (
		!name ||
		name.length > 512 ||
		/[\\<>:"|?*]/.test(name) ||
		[...name].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		) ||
		name.startsWith('/')
	)
		fail(
			'UNSAFE_ARCHIVE_PATH',
			'Re-export the world without unsafe file paths.',
		)
	const path = entry.directory ? name.replace(/\/$/, '') : name
	if (
		path
			.split('/')
			.some(
				(part) =>
					!part ||
					part === '.' ||
					part === '..' ||
					/[. ]$/.test(part) ||
					/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
			)
	)
		fail(
			'UNSAFE_ARCHIVE_PATH',
			'Re-export the world without ambiguous platform file paths.',
		)
	const kind = (entry.externalFileAttributes >>> 16) & 0xf000
	if (
		entry.symlink ||
		(kind !== 0 && kind !== (entry.directory ? 0x4000 : 0x8000))
	)
		fail(
			'UNSAFE_ARCHIVE_PATH',
			'World archives may contain only regular files and directories.',
		)
	if (entry.encrypted) fail('ENCRYPTED_ARCHIVE', 'Export an unencrypted world.')
	if (![0, 8].includes(entry.compressionMethod) || entry.diskNumberStart !== 0)
		fail(
			'UNSUPPORTED_WORLD_FORMAT',
			'Use a single ZIP archive with stored or deflated entries.',
		)
	const normalized = path.normalize('NFKC').toLowerCase()
	// The game can resolve these names case-insensitively on Windows. Never
	// accept an alias that the exact-name inventory below would skip.
	const segments = normalized.split('/')
	const original = path.split('/')
	if (
		([
			'world_behavior_packs.json',
			'world_resource_packs.json',
			'manifest.json',
		].includes(normalized) &&
			path !== normalized) ||
		(['behavior_packs', 'resource_packs'].includes(segments[0]) &&
			(original[0] !== segments[0] ||
				(segments.length === 3 &&
					segments[2] === 'manifest.json' &&
					original[2] !== 'manifest.json')))
	)
		fail(
			'UNSAFE_ARCHIVE_PATH',
			'Use canonical names for bundled pack folders and world pack metadata.',
		)
	return normalized
}

async function consume(
	entry: Entry,
	captureLimit?: number,
): Promise<Uint8Array | undefined> {
	if (entry.directory) fail('INVALID_ARCHIVE', 'Expected a regular file.')
	if (captureLimit !== undefined && entry.uncompressedSize > captureLimit)
		fail('INVALID_WORLD_METADATA', 'World metadata exceeds evaluation limits.')
	let size = 0
	const chunks: Uint8Array[] = []
	await entry.getData(
		new WritableStream<Uint8Array>({
			write(chunk) {
				size += chunk.length
				if (
					size > entry.uncompressedSize ||
					(captureLimit !== undefined && size > captureLimit)
				)
					fail('INVALID_ARCHIVE', 'An archive entry exceeds its declared size.')
				if (captureLimit !== undefined) chunks.push(chunk.slice())
			},
		}),
		{ checkSignature: true },
	)
	if (size !== entry.uncompressedSize)
		fail('INVALID_ARCHIVE', 'An archive entry has an incorrect size.')
	if (captureLimit === undefined) return undefined
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.length
	}
	return bytes
}

/** Validates a stable local byte snapshot. Remote requests use owned snapshots
 * with separate sealed-object identity checks; this is not in-game acceptance. */
export async function validateMapBytes(
	input: Uint8Array,
	fileName: string,
): Promise<MapEvaluationResult> {
	if (!fileName.trim().toLowerCase().endsWith('.mcworld'))
		return {
			valid: false,
			code: 'INVALID_EXTENSION',
			error: 'Maps require one .mcworld file.',
		}
	if (!input.length || input.length > MAP_EVALUATION_POLICY.compressedBytes)
		return {
			valid: false,
			code: 'INVALID_FILE_SIZE',
			error:
				'The in-memory world exceeds 256 MiB or is empty; use file-backed evaluation for larger exports.',
		}
	const bytes = input.slice()
	const sha256 = createHash('sha256').update(bytes).digest('hex')
	return validateSnapshot(
		new ZipReader(new Uint8ArrayReader(bytes), {
			strictness: 'strict',
			useWebWorkers: false,
		}),
		bytes.length,
		sha256,
	)
}

/** Read the source without changing it, hashing while copying to a private
 * temporary snapshot. Only the owned snapshot is removed on completion. */
export async function validateMapFile(
	path: string,
): Promise<MapEvaluationResult> {
	if (!basename(path).toLowerCase().endsWith('.mcworld'))
		return {
			valid: false,
			code: 'INVALID_EXTENSION',
			error: 'Maps require one .mcworld file.',
		}
	let directory: string | undefined
	try {
		const source = await open(path, 'r')
		let fileSize = 0
		const hash = createHash('sha256')
		try {
			const stat = await source.stat()
			if (
				!stat.isFile() ||
				stat.size <= 0 ||
				stat.size > MAP_EVALUATION_POLICY.fileBackedCompressedBytes
			)
				return {
					valid: false,
					code: 'INVALID_FILE_SIZE',
					error:
						'File-backed evaluation requires a nonempty regular file up to 512 MiB.',
				}
			directory = await mkdtemp(join(tmpdir(), 'bedrocknexus-world-'))
			const target = await open(join(directory, 'world.mcworld'), 'wx')
			try {
				for await (const chunk of source.createReadStream({
					autoClose: false,
				})) {
					const bytes = chunk as Buffer
					fileSize += bytes.length
					if (
						fileSize > stat.size ||
						fileSize > MAP_EVALUATION_POLICY.fileBackedCompressedBytes
					)
						throw new Error('Source changed during snapshot')
					hash.update(bytes)
					let offset = 0
					while (offset < bytes.length) {
						const result = await target.write(
							bytes,
							offset,
							bytes.length - offset,
						)
						if (!result.bytesWritten) throw new Error('Cannot write snapshot')
						offset += result.bytesWritten
					}
				}
				if (fileSize !== stat.size)
					throw new Error('Source size changed during snapshot')
			} finally {
				await target.close()
			}
		} finally {
			await source.close()
		}
		return await validateSnapshot(
			new ZipReader(
				new BlobReader(Bun.file(join(directory, 'world.mcworld'))),
				{ strictness: 'strict', useWebWorkers: false },
			),
			fileSize,
			hash.digest('hex'),
		)
	} catch {
		return {
			valid: false,
			code: 'LOCAL_FILE_UNAVAILABLE',
			error:
				'Cannot read the local world or create its bounded temporary snapshot.',
		}
	} finally {
		if (directory) {
			await rm(join(directory, 'world.mcworld'), { force: true })
			await rmdir(directory)
		}
	}
}

async function validateSnapshot(
	reader: Pick<ZipReader<unknown>, 'getEntriesGenerator' | 'close'>,
	fileSize: number,
	sha256: string,
): Promise<MapEvaluationResult> {
	try {
		const entries: Entry[] = []
		const paths = new Map<string, Entry>()
		const packRoots = new Map<string, MapBundledPack['kind']>()
		let expanded = 0
		let compressed = 0
		for await (const entry of reader.getEntriesGenerator()) {
			if (entries.length >= MAP_EVALUATION_POLICY.entries)
				fail(
					'INVALID_ENTRY_COUNT',
					'The world exceeds the evaluation entry limit.',
				)
			const path = checkedPath(entry)
			if (paths.has(path))
				fail(
					'DUPLICATE_ARCHIVE_PATH',
					'The world contains duplicate or ambiguous file paths.',
				)
			paths.set(path, entry)
			entries.push(entry)
			// Bound the inventory before inflating or retaining any manifest JSON.
			const pack = /^(behavior_packs|resource_packs)\/([^/]+)(?:\/|$)/.exec(
				entry.filename,
			)
			if (pack) {
				packRoots.set(
					`${pack[1]}/${pack[2]}`,
					pack[1] === 'behavior_packs' ? 'behavior' : 'resource',
				)
				if (packRoots.size > MAP_EVALUATION_POLICY.packs)
					fail(
						'INVALID_ENTRY_COUNT',
						'A world may bundle at most 64 packs in evaluation.',
					)
			}
			if (
				!Number.isSafeInteger(entry.uncompressedSize) ||
				!Number.isSafeInteger(entry.compressedSize) ||
				entry.uncompressedSize < 0 ||
				entry.compressedSize < 0 ||
				(entry.directory && entry.uncompressedSize !== 0)
			)
				fail('INVALID_ARCHIVE', 'Archive entry sizes are invalid.')
			expanded += entry.uncompressedSize
			compressed += entry.compressedSize
			if (expanded > MAP_EVALUATION_POLICY.expandedBytes)
				fail(
					'UNSAFE_EXPANSION_RATIO',
					'The world exceeds expanded size limits.',
				)
		}
		if (!entries.length)
			fail('INVALID_ENTRY_COUNT', 'The world archive is empty.')
		if (
			expanded / Math.max(compressed, 1) >
			MAP_EVALUATION_POLICY.expansionRatio
		)
			fail(
				'UNSAFE_EXPANSION_RATIO',
				'The world exceeds the expansion ratio limit.',
			)
		for (const [path] of paths) {
			const segments = path.split('/')
			for (let i = 1; i < segments.length; i++) {
				const parent = paths.get(segments.slice(0, i).join('/'))
				if (parent && !parent.directory)
					fail(
						'DUPLICATE_ARCHIVE_PATH',
						'A world path is both a file and a directory.',
					)
			}
			if (path !== 'level.dat' && path.endsWith('/level.dat'))
				fail(
					'AMBIGUOUS_WORLD_ROOT',
					'Zip the contents of exactly one world, without a wrapping folder.',
				)
			if (path.startsWith('region/') || path === 'world_template')
				fail(
					'UNSUPPORTED_WORLD_FORMAT',
					'Upload a Bedrock world export, not a Java world or template.',
				)
			if (/\.(mcpack|mcaddon|mcworld|mctemplate|mcproject|zip)$/.test(path))
				fail(
					'UNSUPPORTED_NESTED_ARCHIVE',
					'Export the world with unpacked bundled packs instead of nested archives.',
				)
		}
		// Canonical root names must match exactly; normalization is for detecting
		// collisions, never silently repairing an archive for the game.
		const level = paths.get('level.dat')
		if (!level || level.directory || level.filename !== 'level.dat')
			fail(
				'MISSING_WORLD_METADATA',
				'Export a world with level.dat at the archive root.',
			)
		if (
			!entries.some(
				(entry) =>
					!entry.directory &&
					entry.filename.startsWith('db/') &&
					entry.uncompressedSize > 0,
			)
		)
			fail(
				'MISSING_WORLD_DATA',
				'Export a complete world with nonempty db/ files.',
			)
		const json = new Map<string, unknown>()
		let world: MapWorldObservations | undefined
		for (const entry of entries) {
			if (entry.directory) continue
			if (entry === level) {
				world = readMapWorldMetadata(
					(await consume(entry, MAP_METADATA_LIMITS.bytes)) as Uint8Array,
				)
			} else if (
				[
					'world_behavior_packs.json',
					'world_resource_packs.json',
					'manifest.json',
				].includes(entry.filename) ||
				/^(behavior_packs|resource_packs)\/[^/]+\/manifest.json$/.test(
					entry.filename,
				)
			) {
				const data = await consume(entry, MAP_EVALUATION_POLICY.jsonBytes)
				try {
					json.set(
						entry.filename,
						JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)),
					)
				} catch {
					fail(
						entry.filename.startsWith('world_')
							? 'INVALID_WORLD_PACK_REFERENCES'
							: 'INVALID_MANIFEST',
						'Re-export the world with valid JSON metadata.',
					)
				}
			} else await consume(entry)
		}
		if (json.has('manifest.json'))
			fail(
				'UNSUPPORTED_WORLD_FORMAT',
				'A root pack manifest is outside the ordinary world export contract.',
			)
		const packs: MapBundledPack[] = []
		const identities = new Set<string>()
		for (const [path, kind] of packRoots) {
			const manifest = json.get(`${path}/manifest.json`)
			if (!manifest)
				fail(
					'MISSING_MANIFEST',
					'Every bundled pack directory needs its own manifest.json.',
				)
			packs.push(readMapPackManifest(manifest, path, kind, identities))
		}
		const active = new Set<string>()
		for (const [file, kind] of [
			['world_behavior_packs.json', 'behavior'],
			['world_resource_packs.json', 'resource'],
		] as const) {
			for (const ref of readMapPackReferences(
				json.has(file) ? json.get(file) : [],
			)) {
				if (
					!packs.some(
						(pack) =>
							pack.kind === kind &&
							packReferenceKey(pack) === packReferenceKey(ref),
					)
				)
					fail(
						'UNRESOLVED_PACK_DEPENDENCY',
						'An activated pack/version is missing from the world export.',
					)
				active.add(ref.uuid)
			}
		}
		for (const pack of packs) {
			for (const entry of pack.scriptEntries) {
				const script = paths.get(
					`${pack.path}/${entry}`.normalize('NFKC').toLowerCase(),
				)
				if (
					!script ||
					script.directory ||
					script.filename !== `${pack.path}/${entry}`
				)
					fail(
						'INVALID_MANIFEST',
						'A bundled script module entry point is missing.',
					)
			}
			for (const dep of pack.dependencies) {
				if (
					!packs.some(
						(candidate) =>
							packReferenceKey(candidate) === packReferenceKey(dep),
					) ||
					dep.uuid === pack.uuid
				)
					fail(
						'UNRESOLVED_PACK_DEPENDENCY',
						'Bundle every required pack at its exact referenced version.',
					)
			}
		}
		const report: MapEvaluationReport = {
			type: 'map',
			schemaVersion: 1,
			validatorVersion: 'maps-offline-1',
			policyVersion: MAP_EVALUATION_POLICY.version,
			fileSize,
			sha256,
			entryCount: entries.length,
			totalUncompressedSize: expanded,
			world: world as MapWorldObservations,
			packs,
			warnings: packs
				.filter((pack) => !active.has(pack.uuid))
				.map((pack) => ({ code: 'INACTIVE_BUNDLED_PACK', path: pack.path })),
		}
		if (
			new TextEncoder().encode(JSON.stringify(report)).length >
			MAP_EVALUATION_POLICY.reportBytes
		)
			fail(
				'REPORT_TOO_LARGE',
				'The complete world report exceeds evaluation limits.',
			)
		return { valid: true, report }
	} catch (error) {
		return error instanceof MapValidationError
			? { valid: false, code: error.code, error: error.message }
			: {
					valid: false,
					code: 'INVALID_ARCHIVE',
					error:
						'Re-export the world: its ZIP contents or checksums are invalid.',
				}
	} finally {
		await reader.close().catch(() => undefined)
	}
}

/** Internal transport helper: caller owns an immutable, bounded snapshot. */
export async function validateOwnedMapSnapshot(
	path: string,
	fileSize: number,
	sha256: string,
): Promise<MapEvaluationResult> {
	return validateSnapshot(
		new ZipReader(new BlobReader(Bun.file(path)), {
			strictness: 'strict',
			useWebWorkers: false,
		}),
		fileSize,
		sha256,
	)
}
