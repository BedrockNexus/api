import { MapValidationError } from './map-world-metadata'

export type MapPackVersion = [number, number, number]
export interface MapPackReference {
	uuid: string
	version: MapPackVersion
}
export interface MapBundledPack extends MapPackReference {
	kind: 'behavior' | 'resource'
	path: string
	moduleTypes: string[]
	minEngineVersion: MapPackVersion
	scriptEntries: string[]
	dependencies: MapPackReference[]
	engineDependencies: { moduleName: string; version: string }[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const invalid = (message: string) =>
	new MapValidationError('INVALID_MANIFEST', message)
export function jsonObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw invalid('A pack manifest must be a JSON object.')
	return value as Record<string, unknown>
}
function uuid(value: unknown): string {
	if (typeof value !== 'string' || !UUID.test(value))
		throw invalid('Pack and module IDs must be UUIDs.')
	return value.toLowerCase()
}
function version(value: unknown): MapPackVersion {
	if (
		!Array.isArray(value) ||
		value.length !== 3 ||
		!value.every(
			(part) =>
				Number.isSafeInteger(part) && part >= 0 && part <= 2_147_483_647,
		)
	)
		throw invalid('Pack versions must contain three nonnegative integers.')
	return value as MapPackVersion
}
export function packReferenceKey(ref: MapPackReference) {
	return `${ref.uuid}@${ref.version.join('.')}`
}

export function readMapPackManifest(
	value: unknown,
	path: string,
	kind: MapBundledPack['kind'],
	identities: Set<string>,
): MapBundledPack {
	const manifest = jsonObject(value)
	if (manifest.format_version !== 2)
		throw new MapValidationError(
			'UNSUPPORTED_WORLD_FORMAT',
			'Only bundled pack manifest format 2 is supported in Maps evaluation.',
		)
	const header = jsonObject(manifest.header)
	if (
		typeof header.name !== 'string' ||
		!header.name.trim() ||
		header.name.length > 256
	)
		throw invalid('Bundled packs need a bounded display name.')
	const id = uuid(header.uuid)
	const packVersion = version(header.version)
	const minEngineVersion = version(header.min_engine_version)
	const reserveId = (value: string) => {
		if (identities.has(value))
			throw invalid('Bundled packs contain duplicate pack or module UUIDs.')
		identities.add(value)
	}
	reserveId(id)
	if (
		!Array.isArray(manifest.modules) ||
		manifest.modules.length < 1 ||
		manifest.modules.length > 64
	)
		throw invalid('Bundled packs need 1-64 supported modules.')
	const scriptEntries: string[] = []
	const moduleTypes = manifest.modules.map((value) => {
		const module = jsonObject(value)
		reserveId(uuid(module.uuid))
		version(module.version)
		if (
			kind === 'resource'
				? module.type !== 'resources'
				: !['data', 'script'].includes(String(module.type))
		)
			throw invalid(
				'Bundled pack modules do not match their behavior/resource directory.',
			)
		if (
			module.type === 'script' &&
			(module.language !== 'javascript' ||
				typeof module.entry !== 'string' ||
				!module.entry)
		)
			throw invalid('Script modules need a JavaScript entry point.')
		if (module.type === 'script') {
			const entry = module.entry as string
			if (
				entry.length > 256 ||
				/[\\:]/.test(entry) ||
				entry.split('/').some((part) => !part || part === '.' || part === '..')
			)
				throw invalid('Script entry points must be safe relative paths.')
			scriptEntries.push(entry)
		}
		return module.type as string
	})
	const dependencies: MapPackReference[] = []
	const engineDependencies: MapBundledPack['engineDependencies'] = []
	if (manifest.dependencies !== undefined) {
		if (
			!Array.isArray(manifest.dependencies) ||
			manifest.dependencies.length > 64
		)
			throw invalid('Bundled pack dependencies exceed the supported limit.')
		const seen = new Set<string>()
		for (const value of manifest.dependencies) {
			const dep = jsonObject(value)
			if (dep.module_name !== undefined) {
				if (
					dep.uuid !== undefined ||
					typeof dep.module_name !== 'string' ||
					!/^@minecraft\/[a-z][a-z0-9-]{0,79}$/.test(dep.module_name) ||
					typeof dep.version !== 'string' ||
					!/^\d+\.\d+\.\d+(?:-(?:beta|internal))?$/.test(dep.version)
				)
					throw invalid('Invalid built-in script dependency.')
				if (seen.has(dep.module_name))
					throw invalid('Duplicate pack dependency.')
				seen.add(dep.module_name)
				engineDependencies.push({
					moduleName: dep.module_name,
					version: dep.version,
				})
			} else {
				const reference = {
					uuid: uuid(dep.uuid),
					version: version(dep.version),
				}
				if (seen.has(reference.uuid))
					throw invalid('Duplicate pack dependency.')
				seen.add(reference.uuid)
				dependencies.push(reference)
			}
		}
	}
	return {
		uuid: id,
		version: packVersion,
		kind,
		path,
		moduleTypes,
		minEngineVersion,
		scriptEntries,
		dependencies,
		engineDependencies,
	}
}

export function readMapPackReferences(value: unknown): MapPackReference[] {
	try {
		if (!Array.isArray(value) || value.length > 64)
			throw invalid('Invalid activation list.')
		const seen = new Set<string>()
		return value.map((value) => {
			const ref = jsonObject(value)
			const id = uuid(ref.pack_id)
			if (seen.has(id)) throw invalid('Duplicate activation reference.')
			seen.add(id)
			return { uuid: id, version: version(ref.version) }
		})
	} catch {
		throw new MapValidationError(
			'INVALID_WORLD_PACK_REFERENCES',
			'Re-export the world with valid pack activation lists.',
		)
	}
}
