import { resolveSrv } from 'node:dns/promises'
import net, { isIP } from 'node:net'
import { resolvePublicTarget } from './public-target'

const MAX_STATUS_RESPONSE_BYTES = 1_048_576
const STATUS_PROTOCOL_VERSION = -1

export interface JavaServerStatus {
	address: string
	host: string
	maxPlayers: number
	motd: string
	online: true
	playerCount: number
	port: number
	protocolVersion?: number
	versionName?: string
}

interface JavaStatusResponse {
	description?:
		| string
		| {
				extra?: unknown[]
				text?: string
		  }
	players?: {
		max?: number
		online?: number
	}
	version?: {
		name?: string
		protocol?: number
	}
}

interface JavaEndpoint {
	handshakeHost: string
	host: string
	port: number
}

function encodeVarInt(input: number) {
	let value = input >>> 0
	const bytes: number[] = []

	do {
		let byte = value & 0x7f
		value >>>= 7
		if (value !== 0) {
			byte |= 0x80
		}
		bytes.push(byte)
	} while (value !== 0)

	return Buffer.from(bytes)
}

function readVarInt(buffer: Buffer, offset = 0) {
	let value = 0
	let position = 0

	for (let index = offset; index < buffer.length; index += 1) {
		const byte = buffer[index]
		value |= (byte & 0x7f) << position
		if ((byte & 0x80) === 0) {
			return { bytes: index - offset + 1, value }
		}

		position += 7
		if (position >= 35) {
			throw new Error('Java status response contains an invalid VarInt')
		}
	}

	return null
}

function encodeString(value: string) {
	const encoded = Buffer.from(value, 'utf8')
	return Buffer.concat([encodeVarInt(encoded.length), encoded])
}

function createHandshake(host: string, port: number) {
	const portBuffer = Buffer.alloc(2)
	portBuffer.writeUInt16BE(port)
	const payload = Buffer.concat([
		Buffer.from([0x00]),
		encodeVarInt(STATUS_PROTOCOL_VERSION),
		encodeString(host),
		portBuffer,
		Buffer.from([0x01]),
	])
	return Buffer.concat([encodeVarInt(payload.length), payload])
}

function extractDescriptionText(value: unknown): string {
	if (typeof value === 'string') {
		return value
	}
	if (!value || typeof value !== 'object') {
		return ''
	}

	const component = value as { extra?: unknown[]; text?: unknown }
	const text = typeof component.text === 'string' ? component.text : ''
	const extra = Array.isArray(component.extra)
		? component.extra.map(extractDescriptionText).join('')
		: ''
	return `${text}${extra}`
}

function parseStatusResponse(buffer: Buffer) {
	const frameLength = readVarInt(buffer)
	if (!frameLength) {
		return null
	}
	if (frameLength.value > MAX_STATUS_RESPONSE_BYTES) {
		throw new Error('Java status response is too large')
	}

	const frameEnd = frameLength.bytes + frameLength.value
	if (buffer.length < frameEnd) {
		return null
	}

	let offset = frameLength.bytes
	const packetId = readVarInt(buffer, offset)
	if (!packetId) {
		return null
	}
	if (packetId.value !== 0) {
		throw new Error('Java status response has an unexpected packet ID')
	}
	offset += packetId.bytes

	const jsonLength = readVarInt(buffer, offset)
	if (!jsonLength) {
		return null
	}
	offset += jsonLength.bytes
	if (offset + jsonLength.value > frameEnd) {
		throw new Error('Java status response has an invalid JSON length')
	}

	return JSON.parse(
		buffer.subarray(offset, offset + jsonLength.value).toString('utf8'),
	) as JavaStatusResponse
}

export async function queryJavaServer(
	host: string,
	port: number,
	timeout = 3000,
	handshakeHost = host,
): Promise<JavaServerStatus | null> {
	const target = await resolvePublicTarget(host)

	return await new Promise((resolve) => {
		const socket = net.createConnection({
			family: target.family,
			host: target.address,
			port,
		})
		let buffer = Buffer.alloc(0)
		let finished = false

		const finish = (result: JavaServerStatus | null) => {
			if (finished) {
				return
			}
			finished = true
			clearTimeout(timer)
			socket.destroy()
			resolve(result)
		}

		const timer = setTimeout(() => finish(null), timeout)
		socket.on('error', () => finish(null))
		socket.on('connect', () => {
			socket.write(createHandshake(handshakeHost, port))
			socket.write(Buffer.from([0x01, 0x00]))
		})
		socket.on('data', (chunk) => {
			const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
			buffer = Buffer.concat([buffer, chunkBuffer])
			if (buffer.length > MAX_STATUS_RESPONSE_BYTES) {
				finish(null)
				return
			}

			try {
				const response = parseStatusResponse(buffer)
				if (!response) {
					return
				}

				finish({
					address: target.address,
					host: target.host,
					maxPlayers: response.players?.max ?? 0,
					motd: extractDescriptionText(response.description),
					online: true,
					playerCount: response.players?.online ?? 0,
					port,
					protocolVersion: response.version?.protocol,
					versionName: response.version?.name,
				})
			} catch {
				finish(null)
			}
		})
	})
}

export async function findJavaEndpoints(
	host: string,
	bedrockPort: number,
): Promise<JavaEndpoint[]> {
	const endpoints = new Map<string, JavaEndpoint>()
	const addEndpoint = (endpoint: JavaEndpoint) => {
		endpoints.set(`${endpoint.host}:${endpoint.port}`, endpoint)
	}

	addEndpoint({ handshakeHost: host, host, port: 25_565 })
	if (bedrockPort !== 25_565) {
		addEndpoint({ handshakeHost: host, host, port: bedrockPort })
	}

	if (!isIP(host)) {
		const records = await resolveSrv(`_minecraft._tcp.${host}`).catch(() => [])
		for (const record of records
			.sort((left, right) => left.priority - right.priority)
			.slice(0, 2)) {
			addEndpoint({
				handshakeHost: host,
				host: record.name.replace(/\.$/, ''),
				port: record.port,
			})
		}
	}

	return [...endpoints.values()].slice(0, 4)
}

export async function probeJavaServers(
	host: string,
	bedrockPort: number,
): Promise<JavaServerStatus[]> {
	const endpoints = await findJavaEndpoints(host, bedrockPort)
	const results = await Promise.all(
		endpoints.map((endpoint) =>
			queryJavaServer(
				endpoint.host,
				endpoint.port,
				3000,
				endpoint.handshakeHost,
			).catch(() => null),
		),
	)

	return results.filter((result): result is JavaServerStatus => result !== null)
}
