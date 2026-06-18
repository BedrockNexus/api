import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import ipaddr from 'ipaddr.js'
import { resolvePublicTarget } from './public-target'

const RAKNET_MAGIC = Buffer.from([
	0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12,
	0x34, 0x56, 0x78,
])
const PONG_HEADER_LENGTH = 35
const PING_RETRY_INTERVAL_MS = 750

export interface BedrockServerInfo {
	edition?: string
	gamemode?: string
	geyserDetected?: boolean
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
	expectedTimestamp: bigint,
): BedrockServerInfo | null {
	if (
		message.length < PONG_HEADER_LENGTH ||
		message[0] !== 0x1c ||
		message.readBigInt64BE(1) !== expectedTimestamp ||
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

export async function pingBedrockServer(
	host: string,
	port = 19_132,
	timeout = 5000,
): Promise<BedrockServerInfo> {
	const target = await resolvePublicTarget(host)

	return await new Promise((resolve) => {
		const socket = dgram.createSocket(target.family === 6 ? 'udp6' : 'udp4')
		const timestamp = BigInt(Date.now())
		let finished = false

		const finish = (result: BedrockServerInfo) => {
			if (finished) {
				return
			}
			finished = true
			clearTimeout(timer)
			clearInterval(retryTimer)
			socket.close()
			resolve(result)
		}

		const timer = setTimeout(() => finish({ online: false }), timeout)

		socket.on('error', () => finish({ online: false }))
		socket.on('message', (message, remote) => {
			if (
				remote.port !== port ||
				!addressesMatch(remote.address, target.address)
			) {
				return
			}

			const result = parseBedrockPong(message, timestamp)
			if (result) {
				finish({ ...result, port: result.port ?? port })
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
					finish({ online: false })
				}
			})
		}
		const retryTimer = setInterval(sendPing, PING_RETRY_INTERVAL_MS)
		sendPing()
	})
}
