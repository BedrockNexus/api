import {
	type Entry,
	HttpRangeReader,
	TextWriter,
	ZipReader,
} from '@zip.js/zip.js'

export const ARTIFACT_TYPES = ['addon', 'map', 'skin', 'resource_pack'] as const

export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export interface ArtifactValidationReport {
	type: ArtifactType
	fileSize: number
	entryCount?: number
	totalUncompressedSize?: number
	manifestCount?: number
	width?: number
	height?: number
}

export type ArtifactValidationResult =
	| { valid: true; report: ArtifactValidationReport }
	| { valid: false; code: string; error: string }

export interface ArtifactValidationRequest {
	type: ArtifactType
	fileName: string
	fileSize: number
	downloadUrl: string
}

const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_MANIFEST_SIZE = 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED_SIZE = 4 * 1024 * 1024 * 1024
const MAX_EXPANSION_RATIO = 200
const MAX_SKIN_SIZE = 2 * 1024 * 1024
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const UNSAFE_ARCHIVE_PATH = /(^|\/)\.\.(\/|$)|^\/|^[a-z]:|\\/i

function hasControlCharacter(value: string) {
	return [...value].some((character) => character.charCodeAt(0) < 32)
}

export class ArtifactValidationError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message)
	}
}

function extensionOf(fileName: string) {
	return fileName.trim().toLowerCase().split('.').pop() ?? ''
}

function expectedExtension(type: ArtifactType) {
	return {
		addon: 'mcaddon',
		map: 'mcworld',
		skin: 'png',
		resource_pack: 'mcpack',
	}[type]
}

function assertExpectedExtension(type: ArtifactType, fileName: string) {
	if (extensionOf(fileName) !== expectedExtension(type)) {
		throw new ArtifactValidationError(
			`This project type requires a .${expectedExtension(type)} file`,
			'INVALID_EXTENSION',
		)
	}
}

export function assertAllowedArtifactUrl(
	rawUrl: string,
	allowedHosts: readonly string[],
) {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		throw new ArtifactValidationError('Invalid artifact URL', 'INVALID_URL')
	}
	if (url.protocol !== 'https:' || url.username || url.password) {
		throw new ArtifactValidationError(
			'Artifact URLs must use HTTPS',
			'INVALID_URL',
		)
	}
	const host = url.hostname.toLowerCase()
	if (!allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
		throw new ArtifactValidationError(
			'Artifact URL host is not allowed',
			'UNTRUSTED_URL',
		)
	}
	return url
}

function validateEntryMetadata(entries: Entry[]) {
	if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
		throw new ArtifactValidationError(
			`Archives must contain between 1 and ${MAX_ARCHIVE_ENTRIES} entries`,
			'INVALID_ENTRY_COUNT',
		)
	}

	const names = new Set<string>()
	let totalUncompressedSize = 0
	let totalCompressedSize = 0
	for (const entry of entries) {
		if (
			UNSAFE_ARCHIVE_PATH.test(entry.filename) ||
			hasControlCharacter(entry.filename)
		) {
			throw new ArtifactValidationError(
				'Archive contains an unsafe file path',
				'UNSAFE_ARCHIVE_PATH',
			)
		}
		const normalizedName = entry.filename.replace(/^\.\//, '').toLowerCase()
		if (names.has(normalizedName)) {
			throw new ArtifactValidationError(
				'Archive contains duplicate file paths',
				'DUPLICATE_ARCHIVE_PATH',
			)
		}
		names.add(normalizedName)
		if (entry.encrypted) {
			throw new ArtifactValidationError(
				'Encrypted archives are not supported',
				'ENCRYPTED_ARCHIVE',
			)
		}
		if (!entry.directory) {
			totalUncompressedSize += entry.uncompressedSize
			totalCompressedSize += Math.max(entry.compressedSize, 1)
		}
	}

	if (
		totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE ||
		totalUncompressedSize / Math.max(totalCompressedSize, 1) >
			MAX_EXPANSION_RATIO
	) {
		throw new ArtifactValidationError(
			'Archive expands beyond the allowed safety limits',
			'UNSAFE_EXPANSION_RATIO',
		)
	}

	return { names, totalUncompressedSize }
}

function getManifestEntries(entries: Entry[]) {
	return entries.filter(
		(entry) =>
			!entry.directory &&
			entry.filename.toLowerCase().split('/').pop() === 'manifest.json',
	)
}

async function readJsonEntry(entry: Entry) {
	if (entry.directory || entry.uncompressedSize > MAX_MANIFEST_SIZE) {
		throw new ArtifactValidationError(
			'Manifest is missing or too large',
			'INVALID_MANIFEST',
		)
	}
	try {
		return JSON.parse(await entry.getData(new TextWriter())) as Record<
			string,
			unknown
		>
	} catch {
		throw new ArtifactValidationError(
			'Manifest contains invalid JSON',
			'INVALID_MANIFEST',
		)
	}
}

function getModuleTypes(manifest: Record<string, unknown>) {
	const modules = Array.isArray(manifest.modules) ? manifest.modules : []
	return modules.flatMap((module) => {
		if (!module || typeof module !== 'object') return []
		const type = (module as Record<string, unknown>).type
		return typeof type === 'string' ? [type] : []
	})
}

async function validatePackArchive(
	type: 'addon' | 'resource_pack',
	entries: Entry[],
) {
	const manifests = getManifestEntries(entries)
	if (manifests.length === 0) {
		throw new ArtifactValidationError(
			'Pack archive does not contain a manifest.json file',
			'MISSING_MANIFEST',
		)
	}
	const moduleTypes = new Set<string>()
	for (const entry of manifests) {
		const manifest = await readJsonEntry(entry)
		if (!(manifest.header && typeof manifest.header === 'object')) {
			throw new ArtifactValidationError(
				'Manifest header is missing',
				'INVALID_MANIFEST',
			)
		}
		for (const moduleType of getModuleTypes(manifest)) {
			moduleTypes.add(moduleType)
		}
	}
	if (type === 'resource_pack' && !moduleTypes.has('resources')) {
		throw new ArtifactValidationError(
			'Resource pack manifest must contain a resources module',
			'INVALID_PACK_TYPE',
		)
	}
	if (
		type === 'addon' &&
		![...moduleTypes].some((value) =>
			['data', 'resources', 'script'].includes(value),
		)
	) {
		throw new ArtifactValidationError(
			'Add-on manifest does not contain a supported module',
			'INVALID_PACK_TYPE',
		)
	}
	return manifests.length
}

function validateWorldArchive(entries: Entry[]) {
	const fileNames = entries
		.filter((entry) => !entry.directory)
		.map((entry) => entry.filename.replace(/^\.\//, '').toLowerCase())
	const levelPath = fileNames.find((name) => name.endsWith('level.dat'))
	if (!levelPath) {
		throw new ArtifactValidationError(
			'World archive does not contain level.dat',
			'MISSING_LEVEL_DAT',
		)
	}
	const prefix = levelPath.slice(0, -'level.dat'.length)
	if (!fileNames.some((name) => name.startsWith(`${prefix}db/`))) {
		throw new ArtifactValidationError(
			'World archive does not contain a Bedrock world database',
			'MISSING_WORLD_DATABASE',
		)
	}
}

async function validateArchive(request: ArtifactValidationRequest) {
	const reader = new ZipReader(new HttpRangeReader(request.downloadUrl), {
		strictness: 'strict',
	})
	try {
		const entries = await reader.getEntries()
		const { totalUncompressedSize } = validateEntryMetadata(entries)
		let manifestCount: number | undefined
		if (request.type === 'map') {
			validateWorldArchive(entries)
		} else if (request.type === 'addon' || request.type === 'resource_pack') {
			manifestCount = await validatePackArchive(request.type, entries)
		}
		return {
			entryCount: entries.length,
			totalUncompressedSize,
			manifestCount,
		}
	} catch (error) {
		if (error instanceof ArtifactValidationError) throw error
		throw new ArtifactValidationError(
			'Artifact is not a valid, unambiguous ZIP archive',
			'INVALID_ARCHIVE',
		)
	} finally {
		await reader.close().catch(() => undefined)
	}
}

async function fetchBounded(url: string, maxSize: number) {
	const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
	if (!response.ok) {
		throw new ArtifactValidationError(
			'Artifact could not be read from storage',
			'ARTIFACT_UNAVAILABLE',
		)
	}
	const contentLength = Number(response.headers.get('content-length'))
	if (contentLength > maxSize) {
		throw new ArtifactValidationError('Artifact is too large', 'FILE_TOO_LARGE')
	}
	const bytes = new Uint8Array(await response.arrayBuffer())
	if (bytes.length === 0 || bytes.length > maxSize) {
		throw new ArtifactValidationError('Artifact is too large', 'FILE_TOO_LARGE')
	}
	return bytes
}

export function validateSkinBytes(bytes: Uint8Array) {
	if (
		bytes.length < 33 ||
		!PNG_SIGNATURE.every((value, index) => bytes[index] === value)
	) {
		throw new ArtifactValidationError('Skin is not a valid PNG', 'INVALID_PNG')
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (view.getUint32(8) !== 13) {
		throw new ArtifactValidationError(
			'Skin PNG has an invalid header',
			'INVALID_PNG',
		)
	}
	const headerType = String.fromCharCode(
		bytes[12],
		bytes[13],
		bytes[14],
		bytes[15],
	)
	if (headerType !== 'IHDR') {
		throw new ArtifactValidationError(
			'Skin PNG has an invalid header',
			'INVALID_PNG',
		)
	}
	const width = view.getUint32(16)
	const height = view.getUint32(20)
	if (width !== 64 || height !== 64) {
		throw new ArtifactValidationError(
			'Skins must be exactly 64x64 pixels',
			'INVALID_SKIN_DIMENSIONS',
		)
	}
	let hasImageData = false
	let hasEnd = false
	for (let offset = 8; offset + 12 <= bytes.length; ) {
		const length = view.getUint32(offset)
		if (offset + 12 + length > bytes.length) {
			throw new ArtifactValidationError('Skin PNG is truncated', 'INVALID_PNG')
		}
		const chunkType = String.fromCharCode(
			bytes[offset + 4],
			bytes[offset + 5],
			bytes[offset + 6],
			bytes[offset + 7],
		)
		if (chunkType === 'acTL') {
			throw new ArtifactValidationError(
				'Animated PNG skins are not supported',
				'ANIMATED_SKIN',
			)
		}
		if (chunkType === 'IDAT') {
			hasImageData = true
		}
		if (chunkType === 'IEND') {
			hasEnd = length === 0 && offset + 12 === bytes.length
			break
		}
		offset += length + 12
	}
	if (!(hasImageData && hasEnd)) {
		throw new ArtifactValidationError('Skin PNG is incomplete', 'INVALID_PNG')
	}
	return { width, height }
}

export async function validateArtifact(
	request: ArtifactValidationRequest,
	allowedHosts: readonly string[],
): Promise<ArtifactValidationResult> {
	try {
		assertExpectedExtension(request.type, request.fileName)
		assertAllowedArtifactUrl(request.downloadUrl, allowedHosts)
		if (!Number.isSafeInteger(request.fileSize) || request.fileSize <= 0) {
			throw new ArtifactValidationError(
				'Invalid file size',
				'INVALID_FILE_SIZE',
			)
		}

		const report: ArtifactValidationReport = {
			type: request.type,
			fileSize: request.fileSize,
		}
		if (request.type === 'skin') {
			Object.assign(
				report,
				validateSkinBytes(
					await fetchBounded(request.downloadUrl, MAX_SKIN_SIZE),
				),
			)
		} else {
			Object.assign(report, await validateArchive(request))
		}
		return { valid: true, report }
	} catch (error) {
		const validationError =
			error instanceof ArtifactValidationError
				? error
				: new ArtifactValidationError(
						'Artifact validation failed',
						'VALIDATION_FAILED',
					)
		return {
			valid: false,
			code: validationError.code,
			error: validationError.message,
		}
	}
}
