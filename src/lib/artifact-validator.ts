import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	BlobReader,
	type Entry,
	HttpRangeReader,
	ZipReader,
} from '@zip.js/zip.js'

export const ARTIFACT_TYPES = ['addon', 'resource_pack'] as const

export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export interface ArtifactValidationReport {
	type: ArtifactType
	fileSize: number
	entryCount?: number
	totalUncompressedSize?: number
	manifestCount?: number
	sha256: string
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
const MAX_EMBEDDED_PACK_SIZE = 256 * 1024 * 1024
const MAX_EMBEDDED_PACKS = 64
const UNSAFE_ARCHIVE_PATH = /(^|\/)\.\.(\/|$)|^\/|^[a-z]:|\\/i
const TEMPORARY_STORAGE_ERRORS = new Set([
	'EACCES',
	'EPERM',
	'EROFS',
	'ENOSPC',
	'ENOENT',
	'EMFILE',
	'ENFILE',
	'EIO',
])

interface ArchiveBudget {
	entryCount: number
	totalUncompressedSize: number
	compressedSize: number
}

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

function validateEntryMetadata(entries: Entry[], budget: ArchiveBudget) {
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
			if (
				!Number.isSafeInteger(entry.uncompressedSize) ||
				!Number.isSafeInteger(entry.compressedSize) ||
				entry.uncompressedSize < 0 ||
				entry.compressedSize < 0
			) {
				throw new ArtifactValidationError(
					'Archive contains invalid entry sizes',
					'INVALID_ARCHIVE',
				)
			}
			totalUncompressedSize += entry.uncompressedSize
			totalCompressedSize += Math.max(entry.compressedSize, 1)
		}
	}
	// Every layer shares the outer ZIP's compressed-data baseline. Container
	// bytes also count as expanded work, so nesting cannot reset the budget.
	if (budget.entryCount === 0) budget.compressedSize = totalCompressedSize
	budget.entryCount += entries.length
	budget.totalUncompressedSize += totalUncompressedSize
	if (budget.entryCount > MAX_ARCHIVE_ENTRIES) {
		throw new ArtifactValidationError(
			'Bundle contains too many archive entries',
			'INVALID_ENTRY_COUNT',
		)
	}

	if (
		totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE ||
		totalUncompressedSize / Math.max(totalCompressedSize, 1) >
			MAX_EXPANSION_RATIO ||
		budget.totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE ||
		budget.totalUncompressedSize / Math.max(budget.compressedSize, 1) >
			MAX_EXPANSION_RATIO
	) {
		throw new ArtifactValidationError(
			'Archive expands beyond the allowed safety limits',
			'UNSAFE_EXPANSION_RATIO',
		)
	}
}

async function readEntries(
	reader: Pick<ZipReader<unknown>, 'getEntriesGenerator'>,
	budget: ArchiveBudget,
) {
	const entries: Entry[] = []
	for await (const entry of reader.getEntriesGenerator()) {
		if (budget.entryCount + entries.length >= MAX_ARCHIVE_ENTRIES) {
			throw new ArtifactValidationError(
				'Bundle contains too many archive entries',
				'INVALID_ENTRY_COUNT',
			)
		}
		entries.push(entry)
	}
	validateEntryMetadata(entries, budget)
	return entries
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
		const chunks: Uint8Array[] = []
		let size = 0
		await entry.getData(
			new WritableStream<Uint8Array>({
				write(chunk) {
					size += chunk.byteLength
					if (size > MAX_MANIFEST_SIZE || size > entry.uncompressedSize) {
						throw new ArtifactValidationError(
							'Manifest is too large',
							'INVALID_MANIFEST',
						)
					}
					chunks.push(chunk.slice())
				},
			}),
			{ checkSignature: true },
		)
		const bytes = new Uint8Array(size)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		const manifest: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(bytes),
		)
		if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
			throw new Error('Manifest must be an object')
		}
		return manifest as Record<string, unknown>
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
	type: ArtifactType,
	entries: Entry[],
	allowEmpty = false,
) {
	const manifests = getManifestEntries(entries)
	if (manifests.length === 0 && !allowEmpty) {
		throw new ArtifactValidationError(
			'Pack archive does not contain a manifest.json file',
			'MISSING_MANIFEST',
		)
	}
	if (manifests.length === 0) return 0
	const moduleTypes = new Set<string>()
	for (const entry of manifests) {
		const manifest = await readJsonEntry(entry)
		if (
			!(manifest.header && typeof manifest.header === 'object') ||
			Array.isArray(manifest.header)
		) {
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

async function validateEmbeddedPack(entry: Entry, budget: ArchiveBudget) {
	if (entry.directory || entry.uncompressedSize > MAX_EMBEDDED_PACK_SIZE) {
		throw new ArtifactValidationError(
			'Embedded packs must not exceed 256 MB',
			'EMBEDDED_PACK_TOO_LARGE',
		)
	}
	const directory = await mkdtemp(join(tmpdir(), 'bedrocknexus-pack-'))
	const fileName = join(directory, 'pack.mcpack')
	try {
		const file = await open(fileName, 'wx')
		try {
			let written = 0
			await entry.getData(
				new WritableStream<Uint8Array>({
					async write(chunk) {
						written += chunk.byteLength
						if (
							written > MAX_EMBEDDED_PACK_SIZE ||
							written > entry.uncompressedSize
						) {
							throw new ArtifactValidationError(
								'Embedded pack exceeds its declared size',
								'EMBEDDED_PACK_TOO_LARGE',
							)
						}
						let offset = 0
						while (offset < chunk.byteLength) {
							const result = await file.write(
								chunk,
								offset,
								chunk.byteLength - offset,
							)
							if (!result.bytesWritten)
								throw new Error('Could not write embedded pack')
							offset += result.bytesWritten
						}
					},
				}),
				{ checkSignature: true },
			)
			if (written !== entry.uncompressedSize)
				throw new Error('Embedded pack size mismatch')
		} finally {
			await file.close()
		}
		const reader = new ZipReader(new BlobReader(Bun.file(fileName)), {
			strictness: 'strict',
		})
		try {
			const entries = await readEntries(reader, budget)
			if (
				entries.some(
					(item) =>
						!item.directory &&
						['mcpack', 'mcaddon'].includes(extensionOf(item.filename)),
				)
			) {
				throw new ArtifactValidationError(
					'Packs inside embedded packs are not supported',
					'NESTED_PACK_DEPTH',
				)
			}
			return await validatePackArchive('addon', entries)
		} finally {
			await reader.close().catch(() => undefined)
		}
	} finally {
		await rm(fileName, { force: true })
		await rmdir(directory)
	}
}

async function validateArchive(request: ArtifactValidationRequest) {
	const reader = new ZipReader(new HttpRangeReader(request.downloadUrl), {
		strictness: 'strict',
	})
	try {
		const budget: ArchiveBudget = {
			entryCount: 0,
			totalUncompressedSize: 0,
			compressedSize: 0,
		}
		const entries = await readEntries(reader, budget)
		const packs = entries.filter(
			(entry) => !entry.directory && extensionOf(entry.filename) === 'mcpack',
		)
		if (packs.length > 0 && request.type !== 'addon') {
			throw new ArtifactValidationError(
				'Only addons may bundle .mcpack archives',
				'NESTED_PACK_DEPTH',
			)
		}
		if (packs.length > MAX_EMBEDDED_PACKS) {
			throw new ArtifactValidationError(
				'Addons may bundle at most 64 packs',
				'INVALID_ENTRY_COUNT',
			)
		}
		let manifestCount = await validatePackArchive(
			request.type,
			entries,
			packs.length > 0,
		)
		for (const pack of packs)
			manifestCount += await validateEmbeddedPack(pack, budget)
		return {
			entryCount: budget.entryCount,
			totalUncompressedSize: budget.totalUncompressedSize,
			manifestCount,
		}
	} catch (error) {
		if (error instanceof ArtifactValidationError) throw error
		if (
			error instanceof Error &&
			'code' in error &&
			TEMPORARY_STORAGE_ERRORS.has(String(error.code))
		) {
			throw new ArtifactValidationError(
				'Temporary archive storage is unavailable',
				'VALIDATOR_UNAVAILABLE',
			)
		}
		throw new ArtifactValidationError(
			'Artifact is not a valid, unambiguous ZIP archive',
			'INVALID_ARCHIVE',
		)
	} finally {
		await reader.close().catch(() => undefined)
	}
}

/**
 * Hashes the whole file, which the archive checks only read parts of. A failed
 * download says nothing about the file, so it is reported as temporary and
 * retried, while a file that is not the declared size is rejected.
 */
async function hashArtifact(request: ArtifactValidationRequest) {
	const hash = createHash('sha256')
	let size = 0

	try {
		const response = await fetch(request.downloadUrl, { redirect: 'error' })
		if (!(response.ok && response.body)) {
			throw new Error(`Artifact download returned HTTP ${response.status}`)
		}
		const reader = response.body.getReader()
		while (size <= request.fileSize) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			size += value.length
			hash.update(value)
		}
		await reader.cancel()
	} catch {
		throw new ArtifactValidationError(
			'The artifact could not be read',
			'VALIDATOR_UNAVAILABLE',
		)
	}

	if (size !== request.fileSize) {
		throw new ArtifactValidationError(
			'The artifact is not the declared size',
			'INVALID_FILE_SIZE',
		)
	}
	return hash.digest('hex')
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

		const archive = await validateArchive(request)
		const report: ArtifactValidationReport = {
			type: request.type,
			fileSize: request.fileSize,
			...archive,
			sha256: await hashArtifact(request),
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
