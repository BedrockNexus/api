import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import net, { isIP } from 'node:net'
import tls from 'node:tls'
import ipaddr from 'ipaddr.js'
import { type ResolvedPublicTarget, resolvePublicTarget } from './public-target'

const RAKNET_MAGIC = Buffer.from([
	0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12,
	0x34, 0x56, 0x78,
])
const PONG_HEADER_LENGTH = 35
const PING_RETRY_INTERVAL_MS = 750
const NETHERNET_STATUS_PATH = '/v1/join'
const MAX_NETHERNET_RESPONSE_BYTES = 16_384
// How long a server that answered on one transport gets to answer on the other,
// so servers running both report the same values whichever replies first.
const TRANSPORT_GRACE_MS = 500
const BEDROCK_GAME_TYPES: Readonly<Record<number, string>> = {
	0: 'Survival',
	1: 'Creative',
	2: 'Adventure',
	6: 'Spectator',
}

export interface BedrockServerInfo {
	edition?: string
	gamemode?: string
	geyserDetected?: boolean
	latencyMs?: number
	mapName?: string
	maxPlayers?: number
	motd?: string
	online: boolean
	playerCount?: number
	port?: number
	protocolVersion?: number
	serverId?: string
	version?: string
}

function normalizeSoftwareMarker(value: string | undefined) {
	return (value ?? '').replaceAll(/§./g, '').trim().toLowerCase()
}

export function detectGeyserFromMotd(
	motd: string | undefined,
	subMotd: string | undefined,
) {
	const primary = normalizeSoftwareMarker(motd)
	const secondary = normalizeSoftwareMarker(subMotd)

	return (
		primary === 'geyser' ||
		primary === 'geysermc' ||
		secondary === 'geyser' ||
		secondary === 'geysermc' ||
		secondary.startsWith('another geyser server') ||
		primary.includes('geysermc.org') ||
		secondary.includes('geysermc.org')
	)
}

function parseNumber(value: string | undefined) {
	if (!value) {
		return undefined
	}
	const number = Number.parseInt(value, 10)
	return Number.isFinite(number) ? number : undefined
}

function addressesMatch(left: string, right: string) {
	try {
		return ipaddr.process(left).toString() === ipaddr.process(right).toString()
	} catch {
		return false
	}
}

export function parseBedrockPong(
	message: Buffer,
	expectedTimestamp?: bigint,
): BedrockServerInfo | null {
	if (
		message.length < PONG_HEADER_LENGTH ||
		message[0] !== 0x1c ||
		(expectedTimestamp !== undefined &&
			message.readBigInt64BE(1) !== expectedTimestamp) ||
		!message.subarray(17, 33).equals(RAKNET_MAGIC)
	) {
		return null
	}

	const payloadLength = message.readUInt16BE(33)
	if (
		payloadLength < 1 ||
		message.length < PONG_HEADER_LENGTH + payloadLength
	) {
		return null
	}

	const parts = message
		.subarray(PONG_HEADER_LENGTH, PONG_HEADER_LENGTH + payloadLength)
		.toString('utf8')
		.split(';')

	if (parts.length < 6 || parts[0] !== 'MCPE') {
		return null
	}

	const motd = parts[1]
	const mapName = parts[7]

	return {
		edition: parts[0],
		gamemode: parts[8],
		geyserDetected: detectGeyserFromMotd(motd, mapName),
		mapName,
		maxPlayers: parseNumber(parts[5]) ?? 0,
		motd,
		online: true,
		playerCount: parseNumber(parts[4]) ?? 0,
		port: parseNumber(parts[10]),
		protocolVersion: parseNumber(parts[2]),
		serverId: parts[6],
		version: parts[3],
	}
}

function isCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the JSON a NetherNet server returns from `GET /v1/join`. Every field the
 * status depends on is required, so an unrelated web server answering that path
 * is not mistaken for a Bedrock server.
 */
export function parseNetherNetStatus(body: string): BedrockServerInfo | null {
	let data: unknown
	try {
		data = JSON.parse(body)
	} catch {
		return null
	}

	if (
		!isJsonObject(data) ||
		typeof data.name !== 'string' ||
		typeof data.version !== 'string' ||
		!isCount(data.protocol) ||
		!isCount(data.players) ||
		!isCount(data.maxPlayers)
	) {
		return null
	}

	const mapName = typeof data.level === 'string' ? data.level : undefined

	return {
		gamemode:
			typeof data.gameType === 'number'
				? BEDROCK_GAME_TYPES[data.gameType]
				: undefined,
		geyserDetected: detectGeyserFromMotd(data.name, mapName),
		mapName,
		maxPlayers: data.maxPlayers,
		motd: data.name,
		online: true,
		playerCount: data.players,
		protocolVersion: data.protocol,
		version: data.version,
	}
}

function decodeChunkedBody(body: Buffer) {
	const chunks: Buffer[] = []
	let offset = 0

	while (offset < body.length) {
		const lineEnd = body.indexOf('\r\n', offset)
		if (lineEnd === -1) {
			break
		}
		const size = Number.parseInt(
			body.subarray(offset, lineEnd).toString('latin1'),
			16,
		)
		if (!Number.isInteger(size) || size <= 0) {
			break
		}
		chunks.push(body.subarray(lineEnd + 2, lineEnd + 2 + size))
		offset = lineEnd + 2 + size + 2
	}

	return Buffer.concat(chunks)
}

/** Returns the body received so far, or null unless the status is 2xx. */
export function readSuccessfulHttpBody(response: Buffer) {
	const headerEnd = response.indexOf('\r\n\r\n')
	if (headerEnd === -1) {
		return null
	}

	const [statusLine, ...headers] = response
		.subarray(0, headerEnd)
		.toString('latin1')
		.split('\r\n')
	if (!/^HTTP\/1\.[01] 2\d\d(?: |$)/.test(statusLine)) {
		return null
	}

	const body = response.subarray(headerEnd + 4)
	const chunked = headers.some((header) =>
		/^transfer-encoding:.*\bchunked\b/i.test(header),
	)
	return (chunked ? decodeChunkedBody(body) : body).toString('utf8')
}

/**
 * Connects straight to the validated address rather than going through a URL, so
 * the hostname is not resolved again and a redirect cannot move the request to
 * another target.
 */
function requestNetherNetStatus(
	target: ResolvedPublicTarget,
	port: number,
	secure: boolean,
	timeout: number,
	signal: AbortSignal,
) {
	return new Promise<BedrockServerInfo | null>((resolve) => {
		const address = { family: target.family, host: target.address, port }
		// The status is public and the same server may also answer over plain
		// HTTP, so an untrusted certificate is not treated as being offline.
		const socket = secure
			? tls.connect({
					...address,
					rejectUnauthorized: false,
					servername: isIP(target.host) ? undefined : target.host,
				})
			: net.createConnection(address)
		const startedAt = performance.now()
		let connectedAfterMs: number | undefined
		let received = Buffer.alloc(0)
		let finished = false

		const finish = (result: BedrockServerInfo | null) => {
			if (finished) {
				return
			}
			finished = true
			clearTimeout(timer)
			signal.removeEventListener('abort', abort)
			socket.destroy()
			resolve(result)
		}
		const abort = () => finish(null)

		const timer = setTimeout(abort, timeout)
		signal.addEventListener('abort', abort, { once: true })

		socket.on('error', abort)
		socket.on('close', abort)
		// One round trip, comparable with a RakNet ping. Timing the whole request
		// would also count the TLS and HTTP exchanges.
		socket.once('connect', () => {
			connectedAfterMs = performance.now() - startedAt
		})
		socket.once(secure ? 'secureConnect' : 'connect', () => {
			const hostHeader =
				isIP(target.host) === 6 ? `[${target.host}]` : target.host
			socket.write(
				`GET ${NETHERNET_STATUS_PATH} HTTP/1.1\r\nHost: ${hostHeader}:${port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
			)
		})
		socket.on('data', (chunk) => {
			received = Buffer.concat([received, Buffer.from(chunk)])
			if (received.length > MAX_NETHERNET_RESPONSE_BYTES) {
				finish(null)
				return
			}

			// A partial body is not valid JSON, so this succeeds only when complete.
			const body = readSuccessfulHttpBody(received)
			const result = body === null ? null : parseNetherNetStatus(body)
			if (result) {
				finish({
					...result,
					latencyMs: toLatency(
						connectedAfterMs ?? performance.now() - startedAt,
					),
				})
			}
		})
	})
}

function toLatency(elapsedMs: number) {
	return Math.max(1, Math.round(elapsedMs))
}

/** Resolves with the first probe that gets an answer, or null if none do. */
async function firstAnswer(probes: Promise<BedrockServerInfo | null>[]) {
	return await Promise.any(
		probes.map(async (probe) => {
			const result = await probe
			if (!result) {
				throw new Error('No answer')
			}
			return result
		}),
	).catch(() => null)
}

/**
 * Signaling may be served over HTTPS or plain HTTP on the same port and nothing
 * advertises which, so both are tried at once.
 */
export async function queryNetherNetStatus(
	target: ResolvedPublicTarget,
	port: number,
	timeout: number,
	signal: AbortSignal = new AbortController().signal,
) {
	const attempts = new AbortController()
	const attemptSignal = AbortSignal.any([signal, attempts.signal])
	const result = await firstAnswer(
		[true, false].map((secure) =>
			requestNetherNetStatus(target, port, secure, timeout, attemptSignal),
		),
	)
	attempts.abort()
	return result
}

function pingRakNet(
	target: ResolvedPublicTarget,
	port: number,
	timeout: number,
	signal: AbortSignal,
) {
	return new Promise<BedrockServerInfo | null>((resolve) => {
		const socket = dgram.createSocket(target.family === 6 ? 'udp6' : 'udp4')
		const timestamp = BigInt(Date.now())
		const startedAt = performance.now()
		let finished = false

		const finish = (result: BedrockServerInfo | null) => {
			if (finished) {
				return
			}
			finished = true
			clearTimeout(timer)
			clearInterval(retryTimer)
			signal.removeEventListener('abort', abort)
			socket.close()
			resolve(result)
		}
		const abort = () => finish(null)

		const timer = setTimeout(abort, timeout)
		signal.addEventListener('abort', abort, { once: true })

		socket.on('error', abort)
		socket.on('message', (message, remote) => {
			if (
				remote.port !== port ||
				!addressesMatch(remote.address, target.address)
			) {
				return
			}

			// Some Bedrock proxies replace the ping timestamp instead of echoing it.
			// The source endpoint, packet type, RakNet magic, and MCPE payload still
			// provide the validation needed for a status response.
			const result = parseBedrockPong(message)
			if (result) {
				finish({
					...result,
					latencyMs: toLatency(performance.now() - startedAt),
				})
			}
		})

		const sendPing = () => {
			const packet = Buffer.alloc(33)
			packet[0] = 0x01
			packet.writeBigInt64BE(timestamp, 1)
			RAKNET_MAGIC.copy(packet, 9)
			randomBytes(8).copy(packet, 25)

			socket.send(packet, port, target.address, (error) => {
				if (error) {
					abort()
				}
			})
		}
		const retryTimer = setInterval(sendPing, PING_RETRY_INTERVAL_MS)
		sendPing()
	})
}

/**
 * Combines the transports' answers. NetherNet is what current clients read for
 * the server list, so its values win; RakNet fills in what it alone reports.
 */
export function mergeTransportResults(
	raknet: BedrockServerInfo | null,
	nethernet: BedrockServerInfo | null,
): BedrockServerInfo | null {
	if (!(raknet && nethernet)) {
		return raknet ?? nethernet
	}

	return {
		...raknet,
		...nethernet,
		gamemode: nethernet.gamemode ?? raknet.gamemode,
		geyserDetected: raknet.geyserDetected || nethernet.geyserDetected,
		latencyMs: raknet.latencyMs,
		mapName: nethernet.mapName ?? raknet.mapName,
	}
}

/**
 * Checks a validated target over both transports. Bedrock 26.60 clients connect
 * only over NetherNet, whose servers may not answer RakNet pings, while servers
 * that have not migrated answer only RakNet. Either answer means online.
 */
export async function probeBedrockTarget(
	target: ResolvedPublicTarget,
	port: number,
	timeout: number,
): Promise<BedrockServerInfo> {
	const grace = new AbortController()
	const raknet = pingRakNet(target, port, timeout, grace.signal)
	const nethernet = queryNetherNetStatus(target, port, timeout, grace.signal)

	if (!(await firstAnswer([raknet, nethernet]))) {
		return { online: false }
	}

	const graceTimer = setTimeout(() => grace.abort(), TRANSPORT_GRACE_MS)
	const [raknetResult, nethernetResult] = await Promise.all([raknet, nethernet])
	clearTimeout(graceTimer)

	const result = mergeTransportResults(raknetResult, nethernetResult)
	return result ? { ...result, port: result.port ?? port } : { online: false }
}

export async function pingBedrockServer(
	host: string,
	port = 19_132,
	timeout = 5000,
): Promise<BedrockServerInfo> {
	return await probeBedrockTarget(
		await resolvePublicTarget(host),
		port,
		timeout,
	)
}
