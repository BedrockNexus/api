/** Offline candidate parser. Supported storage versions are fixture-backed. */
export const MAP_METADATA_LIMITS = {
	bytes: 1024 * 1024,
	depth: 32,
	tags: 50_000,
	collectionLength: 16_384,
	stringBytes: 32_768,
} as const

export class MapValidationError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}

export interface MapWorldObservations {
	storageVersion: number
	commandBlocksEnabled?: boolean
	commandsEnabled?: boolean
	experiments?: string[]
}

/** Parses file NBT only: uncompressed, little endian, with an eight-byte header.
 * No format guessing, gzip, network NBT, or database access. */
export function readMapWorldMetadata(bytes: Uint8Array): MapWorldObservations {
	const invalid = () =>
		new MapValidationError(
			'INVALID_WORLD_METADATA',
			'Re-export the world: level.dat is malformed or exceeds metadata limits.',
		)
	if (bytes.length < 12 || bytes.length > MAP_METADATA_LIMITS.bytes)
		throw invalid()
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const storageVersion = view.getUint32(0, true)
	if (storageVersion !== 9) {
		throw new MapValidationError(
			'UNSUPPORTED_WORLD_FORMAT',
			'This world metadata storage version is not supported yet.',
		)
	}
	if (view.getUint32(4, true) !== bytes.length - 8) throw invalid()
	let offset = 8
	let tags = 0
	const decoder = new TextDecoder('utf-8', { fatal: true })
	function take(size: number) {
		if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length)
			throw invalid()
		const start = offset
		offset += size
		return start
	}
	function byte() {
		return view.getUint8(take(1))
	}
	function int() {
		return view.getInt32(take(4), true)
	}
	function text() {
		const size = view.getUint16(take(2), true)
		if (size > MAP_METADATA_LIMITS.stringBytes) throw invalid()
		const start = take(size)
		return decoder.decode(bytes.subarray(start, start + size))
	}
	function count() {
		const length = int()
		if (length < 0 || length > MAP_METADATA_LIMITS.collectionLength)
			throw invalid()
		return length
	}
	function payload(type: number, depth: number): unknown {
		if (++tags > MAP_METADATA_LIMITS.tags || depth > MAP_METADATA_LIMITS.depth)
			throw invalid()
		switch (type) {
			case 1:
				return view.getInt8(take(1))
			case 2:
				return view.getInt16(take(2), true)
			case 3:
				return int()
			case 4:
				take(8)
				return null // Longs (including seeds) are never reported.
			case 5:
				return view.getFloat32(take(4), true)
			case 6:
				return view.getFloat64(take(8), true)
			case 7:
				take(count())
				return null
			case 8:
				return text()
			case 9: {
				const childType = byte()
				const length = count()
				if (childType > 12 || (childType === 0 && length > 0)) throw invalid()
				for (let i = 0; i < length; i++) payload(childType, depth + 1)
				return null
			}
			case 10: {
				const compound = new Map<string, unknown>()
				for (let childType = byte(); childType !== 0; childType = byte()) {
					const name = text()
					if (compound.has(name)) throw invalid()
					compound.set(name, payload(childType, depth + 1))
				}
				return compound
			}
			case 11:
				take(count() * 4)
				return null
			case 12:
				take(count() * 8)
				return null
			default:
				throw invalid()
		}
	}
	try {
		if (byte() !== 10) throw invalid()
		text()
		const root = payload(10, 0) as Map<string, unknown>
		if (offset !== bytes.length) throw invalid()
		function bool(name: string) {
			const value = root.get(name)
			return value === 0 ? false : value === 1 ? true : undefined
		}
		const experiments = root.get('experiments')
		const enabled =
			experiments instanceof Map
				? [...experiments]
						.filter(
							([key, value]) =>
								value === 1 &&
								![
									'experiments_ever_used',
									'saved_with_toggled_experiments',
								].includes(key),
						)
						.map(([key]) => key)
				: undefined
		if (
			enabled &&
			(enabled.length > 32 || enabled.some((name) => name.length > 100))
		)
			throw invalid()
		return {
			storageVersion,
			...(bool('commandblocksenabled') !== undefined
				? { commandBlocksEnabled: bool('commandblocksenabled') }
				: {}),
			...(bool('commandsEnabled') !== undefined
				? { commandsEnabled: bool('commandsEnabled') }
				: {}),
			...(enabled ? { experiments: enabled } : {}),
		}
	} catch (error) {
		if (error instanceof MapValidationError) throw error
		throw invalid()
	}
}
