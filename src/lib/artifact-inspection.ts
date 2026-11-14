import type { Entry, FileEntry } from '@zip.js/zip.js'

/**
 * Content checks on the files inside a pack, on top of the archive checks in
 * artifact-validator.ts. Minecraft runs pack scripts in a sandbox, so the
 * risk is in what a player could open themselves: programs and system scripts
 * are rejected outright, and anything else unusual is reported for the
 * moderator who reviews the release.
 */

export interface ArtifactFile {
	path: string
	size: number
	crc32: number
}

export interface ArtifactFinding {
	code: string
	level: 'warning' | 'info'
	message: string
	paths?: string[]
}

export interface ScriptModule {
	name: string
	version?: string
}

export type PackKind = 'behavior' | 'resources' | 'skins' | 'world' | 'other'

/** A pack's identity from its manifest header. */
export interface PackIdentity {
	uuid: string
	version?: string
	kind: PackKind
	minEngineVersion?: string
}

/** A pack another pack in the archive needs, by UUID. */
export interface PackDependency {
	uuid: string
	version?: string
}

export interface ArtifactInspectionReport {
	files: ArtifactFile[]
	filesTruncated: boolean
	scriptModules: ScriptModule[]
	findings: ArtifactFinding[]
	packs: PackIdentity[]
	packDependencies: PackDependency[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_PACK_IDENTITIES = 64

function packUuid(value: unknown) {
	const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
	return UUID.test(text) ? text : undefined
}

/** `[1, 21, 0]` or `"1.21.0"` as `"1.21.0"`; anything else undefined. */
function versionLabel(value: unknown) {
	if (typeof value === 'string' && value.trim()) {
		return value.trim().slice(0, 40)
	}
	if (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((part) => Number.isInteger(part) && part >= 0)
	) {
		return value.join('.').slice(0, 40)
	}
	return undefined
}

function packKind(moduleTypes: string[]): PackKind {
	if (moduleTypes.includes('data') || moduleTypes.includes('script'))
		return 'behavior'
	if (moduleTypes.includes('resources')) return 'resources'
	if (moduleTypes.includes('skin_pack')) return 'skins'
	if (moduleTypes.includes('world_template')) return 'world'
	return 'other'
}

/** Files Bedrock reads from a behavior or resource pack. */
const PACK_EXTENSIONS = new Set([
	'json',
	'png',
	'tga',
	'jpg',
	'jpeg',
	'lang',
	'js',
	'ogg',
	'wav',
	'fsb',
	'mcfunction',
	'material',
	'mcstructure',
	'txt',
	'md',
	'fragment',
	'vertex',
	'mcpack',
])

/** Files with no extension that packs often carry. */
const PLAIN_NAMES = new Set(['license', 'readme', 'changelog', 'notice'])

/** Programs, installers, shortcuts and system scripts. */
const BLOCKED_EXTENSIONS = new Set([
	'exe',
	'dll',
	'scr',
	'com',
	'bat',
	'cmd',
	'ps1',
	'psm1',
	'vbs',
	'vbe',
	'jse',
	'wsf',
	'wsh',
	'msi',
	'msp',
	'lnk',
	'url',
	'hta',
	'cpl',
	'pif',
	'reg',
	'jar',
	'apk',
	'app',
	'dmg',
	'pkg',
	'deb',
	'rpm',
	'appimage',
	'sh',
	'bash',
	'command',
	'desktop',
	'so',
	'dylib',
	'sys',
	'drv',
	'ocx',
	'iso',
	'vhd',
	'vhdx',
])

/** Modules that reach beyond the game world on a dedicated server. */
const SENSITIVE_MODULES: Record<string, { code: string; message: string }> = {
	'@minecraft/server-net': {
		code: 'NETWORK_MODULE',
		message:
			'Uses @minecraft/server-net, which can send web requests from a dedicated server.',
	},
	'@minecraft/server-admin': {
		code: 'ADMIN_MODULE',
		message:
			'Uses @minecraft/server-admin, which can read server secrets and variables.',
	},
}

export const MAX_LISTED_FILES = 5000
/** Unknown files whose first bytes are read, and scripts that are read whole. */
const MAX_SNIFFED_FILES = 200
const MAX_SCANNED_SCRIPTS = 50
const MAX_SCANNED_SCRIPT_SIZE = 2 * 1024 * 1024
const MAX_PATHS_PER_FINDING = 10
const SNIFF_BYTES = 4

const OBFUSCATOR_NAMES = /\b_0x[0-9a-f]{4,}\b/gi
const HEX_ESCAPES = /\\x[0-9a-f]{2}/gi
const DYNAMIC_CODE = /\beval\s*\(|\bnew\s+Function\s*\(/
const LONG_LINE = 5000

export class BlockedContentError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message)
	}
}

class StopReading extends Error {}

function extensionOf(path: string) {
	const name = path.toLowerCase().split('/').pop() ?? ''
	const dot = name.lastIndexOf('.')
	return dot > 0 ? name.slice(dot + 1) : ''
}

function baseName(path: string) {
	return path.split('/').pop() ?? path
}

function startsWith(bytes: Uint8Array, signature: number[]) {
	return signature.every((byte, index) => bytes[index] === byte)
}

/** A program for Windows, Linux or macOS, or a script with an interpreter line. */
export function isExecutable(bytes: Uint8Array) {
	return (
		startsWith(bytes, [0x4d, 0x5a]) || // MZ: Windows programs and libraries
		startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
		startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
		startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
		startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) ||
		startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
		startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]) || // Mach-O universal
		startsWith(bytes, [0x23, 0x21]) // #!
	)
}

async function readStart(entry: FileEntry) {
	const bytes = new Uint8Array(SNIFF_BYTES)
	let length = 0
	// Stop decompressing once the first bytes are in. (Throwing from the
	// stream instead leaves zip.js waiting.)
	const stop = new AbortController()
	try {
		await entry.getData(
			new WritableStream<Uint8Array>({
				write(chunk) {
					if (length >= SNIFF_BYTES) return
					const take = Math.min(chunk.byteLength, SNIFF_BYTES - length)
					bytes.set(chunk.subarray(0, take), length)
					length += take
					if (length >= SNIFF_BYTES) stop.abort(new StopReading())
				},
			}),
			{ signal: stop.signal },
		)
	} catch (error) {
		if (!stop.signal.aborted) throw error
	}
	return bytes.subarray(0, length)
}

async function readText(entry: FileEntry) {
	const chunks: Uint8Array[] = []
	let size = 0
	const stop = new AbortController()
	await entry.getData(
		new WritableStream<Uint8Array>({
			write(chunk) {
				size += chunk.byteLength
				if (size > MAX_SCANNED_SCRIPT_SIZE) {
					stop.abort(new StopReading())
					return
				}
				chunks.push(chunk.slice())
			},
		}),
		{ checkSignature: true, signal: stop.signal },
	)
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder('utf-8').decode(bytes)
}

/** What a script's text suggests about how it was written. */
export function scriptTraits(source: string) {
	const obfuscatorNames = source.match(OBFUSCATOR_NAMES)?.length ?? 0
	const hexEscapes = source.match(HEX_ESCAPES)?.length ?? 0
	return {
		obfuscated: obfuscatorNames >= 20 || hexEscapes >= 200,
		dynamicCode: DYNAMIC_CODE.test(source),
		minified: source.split('\n').some((line) => line.length > LONG_LINE),
	}
}

export class ArtifactInspection {
	private readonly files: ArtifactFile[] = []
	private filesTruncated = false
	private readonly modules = new Map<string, string | undefined>()
	private readonly packs = new Map<string, PackIdentity>()
	private readonly dependsOn = new Map<string, string | undefined>()
	private readonly unusual = new Map<string, string[]>()
	private readonly flagged = new Map<string, string[]>()
	private sniffed = 0
	private scanned = 0
	private unscannedScripts = 0
	private unsniffedFiles = 0

	/**
	 * Lists one archive's files (inside an embedded pack, under `prefix`),
	 * rejects programs by name, and reads unusual files and scripts.
	 */
	async inspect(entries: Entry[], prefix = '') {
		const unknown: FileEntry[] = []
		const scripts: FileEntry[] = []
		for (const entry of entries) {
			if (entry.directory) continue
			const extension = extensionOf(entry.filename)
			if (BLOCKED_EXTENSIONS.has(extension)) {
				throw new BlockedContentError(
					`Packs can't contain programs or system scripts (found ${baseName(entry.filename)})`,
					'BLOCKED_FILE_TYPE',
				)
			}
			// The pack itself is listed through its own files.
			if (extension !== 'mcpack') this.list(entry, prefix)
			if (extension === 'js') scripts.push(entry)
			else if (!PACK_EXTENSIONS.has(extension)) {
				if (
					!(
						extension === '' &&
						PLAIN_NAMES.has(baseName(entry.filename).toLowerCase())
					)
				)
					this.note(
						this.unusual,
						extension || '(none)',
						prefix + entry.filename,
					)
				unknown.push(entry)
			}
		}
		for (const entry of unknown) await this.sniff(entry, prefix)
		for (const entry of scripts) await this.scan(entry, prefix)
	}

	/**
	 * Records a manifest's pack identity, the packs it depends on by UUID,
	 * and the script modules it depends on.
	 */
	addManifest(manifest: Record<string, unknown>) {
		const header =
			manifest.header && typeof manifest.header === 'object'
				? (manifest.header as Record<string, unknown>)
				: {}
		const uuid = packUuid(header.uuid)
		if (
			uuid &&
			!this.packs.has(uuid) &&
			this.packs.size < MAX_PACK_IDENTITIES
		) {
			const modules = Array.isArray(manifest.modules) ? manifest.modules : []
			const moduleTypes = modules.flatMap((module) =>
				module &&
				typeof module === 'object' &&
				typeof (module as Record<string, unknown>).type === 'string'
					? [(module as Record<string, unknown>).type as string]
					: [],
			)
			const version = versionLabel(header.version)
			const minEngineVersion = versionLabel(header.min_engine_version)
			this.packs.set(uuid, {
				uuid,
				kind: packKind(moduleTypes),
				...(version ? { version } : {}),
				...(minEngineVersion ? { minEngineVersion } : {}),
			})
		}
		const dependencies = Array.isArray(manifest.dependencies)
			? manifest.dependencies
			: []
		for (const dependency of dependencies) {
			if (!dependency || typeof dependency !== 'object') continue
			const dependencyUuid = packUuid(
				(dependency as Record<string, unknown>).uuid,
			)
			if (dependencyUuid) {
				if (this.dependsOn.size < MAX_PACK_IDENTITIES)
					this.dependsOn.set(
						dependencyUuid,
						versionLabel((dependency as Record<string, unknown>).version),
					)
				continue
			}
			const { module_name: name, version } = dependency as Record<
				string,
				unknown
			>
			if (typeof name !== 'string' || !name.trim()) continue
			let label: string | undefined
			if (typeof version === 'string') label = version
			else if (Array.isArray(version)) label = version.join('.')
			this.modules.set(name.trim().slice(0, 100), label?.slice(0, 40))
		}
	}

	report(): ArtifactInspectionReport {
		const findings: ArtifactFinding[] = []
		for (const name of this.modules.keys()) {
			const sensitive = SENSITIVE_MODULES[name]
			if (sensitive) findings.push({ level: 'warning', ...sensitive })
		}
		const finding = (
			code: string,
			level: ArtifactFinding['level'],
			message: (count: number) => string,
		) => {
			const paths = this.flagged.get(code)
			if (paths?.length)
				findings.push({
					code,
					level,
					message: message(paths.length),
					paths: paths.slice(0, MAX_PATHS_PER_FINDING),
				})
		}
		finding(
			'OBFUSCATED_SCRIPT',
			'warning',
			(count) =>
				`${count === 1 ? 'A script looks' : `${count} scripts look`} deliberately obfuscated.`,
		)
		finding(
			'DYNAMIC_CODE',
			'warning',
			(count) =>
				`${count === 1 ? 'A script builds' : `${count} scripts build`} code at runtime (eval or new Function).`,
		)
		finding(
			'MINIFIED_SCRIPT',
			'info',
			(count) =>
				`${count === 1 ? 'A script is' : `${count} scripts are`} minified, so it is hard to read.`,
		)
		if (this.unusual.size) {
			const types = [...this.unusual.entries()]
				.map(([extension, paths]) =>
					extension === '(none)'
						? `${paths.length} without an extension`
						: `.${extension} (${paths.length})`,
				)
				.join(', ')
			findings.push({
				code: 'UNUSUAL_FILES',
				level: 'info',
				message: `Files Minecraft does not use: ${types}.`,
				paths: [...this.unusual.values()]
					.flat()
					.slice(0, MAX_PATHS_PER_FINDING),
			})
		}
		if (this.unscannedScripts || this.unsniffedFiles) {
			findings.push({
				code: 'NOT_FULLY_SCANNED',
				level: 'info',
				message: `Too many files to read them all: ${this.unscannedScripts} scripts and ${this.unsniffedFiles} other files were not read.`,
			})
		}
		return {
			files: this.files,
			filesTruncated: this.filesTruncated,
			scriptModules: [...this.modules.entries()].map(([name, version]) =>
				version ? { name, version } : { name },
			),
			findings,
			packs: [...this.packs.values()],
			// Packs in the same archive satisfy each other.
			packDependencies: [...this.dependsOn.entries()]
				.filter(([uuid]) => !this.packs.has(uuid))
				.map(([uuid, version]) => (version ? { uuid, version } : { uuid })),
		}
	}

	private list(entry: Entry, prefix: string) {
		if (this.files.length >= MAX_LISTED_FILES) {
			this.filesTruncated = true
			return
		}
		this.files.push({
			path: prefix + entry.filename.replace(/^\.\//, ''),
			size: entry.uncompressedSize,
			crc32: entry.signature ?? 0,
		})
	}

	private note(map: Map<string, string[]>, key: string, path: string) {
		const paths = map.get(key) ?? []
		paths.push(path)
		map.set(key, paths)
	}

	private async sniff(entry: FileEntry, prefix: string) {
		if (entry.uncompressedSize === 0) return
		if (this.sniffed >= MAX_SNIFFED_FILES) {
			this.unsniffedFiles++
			return
		}
		this.sniffed++
		if (isExecutable(await readStart(entry))) {
			throw new BlockedContentError(
				`Packs can't contain programs or system scripts (${baseName(prefix + entry.filename)} is one)`,
				'EXECUTABLE_CONTENT',
			)
		}
	}

	private async scan(entry: FileEntry, prefix: string) {
		if (
			this.scanned >= MAX_SCANNED_SCRIPTS ||
			entry.uncompressedSize > MAX_SCANNED_SCRIPT_SIZE
		) {
			this.unscannedScripts++
			return
		}
		this.scanned++
		const traits = scriptTraits(await readText(entry))
		const path = prefix + entry.filename
		if (traits.obfuscated) this.note(this.flagged, 'OBFUSCATED_SCRIPT', path)
		if (traits.dynamicCode) this.note(this.flagged, 'DYNAMIC_CODE', path)
		if (traits.minified && !traits.obfuscated)
			this.note(this.flagged, 'MINIFIED_SCRIPT', path)
	}
}
