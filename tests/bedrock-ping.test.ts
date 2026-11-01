import { afterEach, describe, expect, test } from 'bun:test'
import dgram from 'node:dgram'
import net from 'node:net'
import {
	detectGeyserFromMotd,
	mergeTransportResults,
	parseBedrockPong,
	parseNetherNetStatus,
	pingBedrockServer,
	probeBedrockTarget,
	queryNetherNetStatus,
	readSuccessfulHttpBody,
} from '../src/lib/bedrock-ping'
import { PublicTargetError } from '../src/lib/public-target'

const RAKNET_MAGIC = Buffer.from([
	0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12,
	0x34, 0x56, 0x78,
])

function createPong(payload: string, timestamp: bigint) {
	const payloadBuffer = Buffer.from(payload)
	const packet = Buffer.alloc(35 + payloadBuffer.length)
	packet[0] = 0x1c
	packet.writeBigInt64BE(timestamp, 1)
	RAKNET_MAGIC.copy(packet, 17)
	packet.writeUInt16BE(payloadBuffer.length, 33)
	payloadBuffer.copy(packet, 35)
	return packet
}

describe('Bedrock pong parsing', () => {
	test('parses a valid unconnected pong', () => {
		const timestamp = 123n
		const result = parseBedrockPong(
			createPong(
				'MCPE;Bedrock Nexus;827;1.21.80;12;100;server-id;Second line;Survival;1;19132;19133',
				timestamp,
			),
			timestamp,
		)

		expect(result).toEqual({
			edition: 'MCPE',
			gamemode: 'Survival',
			geyserDetected: false,
			mapName: 'Second line',
			maxPlayers: 100,
			motd: 'Bedrock Nexus',
			online: true,
			playerCount: 12,
			port: 19_132,
			protocolVersion: 827,
			serverId: 'server-id',
			version: '1.21.80',
		})
	})

	test('detects Geyser default and explicit branding', () => {
		expect(detectGeyserFromMotd('Geyser', 'Another Geyser server.')).toBe(true)
		expect(
			detectGeyserFromMotd('Crossplay server', 'Visit geysermc.org for help'),
		).toBe(true)
		expect(detectGeyserFromMotd('Native Bedrock', 'Survival network')).toBe(
			false,
		)
	})

	test('rejects packets with the wrong timestamp or magic', () => {
		const timestamp = 123n
		const packet = createPong('MCPE;Test;1;1.0;0;10', timestamp)

		expect(parseBedrockPong(packet, 124n)).toBeNull()
		packet[17] = 0xff
		expect(parseBedrockPong(packet, timestamp)).toBeNull()
	})

	test('accepts proxy pongs that replace the ping timestamp', () => {
		const packet = createPong('MCPE;Proxy;1;1.0;2;100', 456n)

		expect(parseBedrockPong(packet)?.online).toBe(true)
	})

	test('rejects non-Bedrock edition responses', () => {
		const timestamp = 123n
		const packet = createPong('MINECRAFT;Test;1;1.0;0;10', timestamp)

		expect(parseBedrockPong(packet, timestamp)).toBeNull()
	})

	test('rejects truncated payloads', () => {
		const timestamp = 123n
		const packet = createPong('MCPE;Test;1;1.0;0;10', timestamp)
		packet.writeUInt16BE(500, 33)

		expect(parseBedrockPong(packet, timestamp)).toBeNull()
	})
})

const NETHERNET_BODY = JSON.stringify({
	gameType: 0,
	level: 'Server Network',
	maxPlayers: 30,
	name: 'Halloween',
	players: 1,
	protocol: 2225,
	version: '1.26.60',
})

function httpResponse(body: string, status = '200 OK') {
	return `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

describe('NetherNet status parsing', () => {
	test('maps the documented fields', () => {
		expect(parseNetherNetStatus(NETHERNET_BODY)).toEqual({
			gamemode: 'Survival',
			geyserDetected: false,
			mapName: 'Server Network',
			maxPlayers: 30,
			motd: 'Halloween',
			online: true,
			playerCount: 1,
			protocolVersion: 2225,
			version: '1.26.60',
		})
	})

	test('detects Geyser branding from the server name and level', () => {
		const body = JSON.parse(NETHERNET_BODY)

		expect(
			parseNetherNetStatus(
				JSON.stringify({ ...body, level: 'Another Geyser server.' }),
			)?.geyserDetected,
		).toBe(true)
	})

	test.each([
		['non-JSON', 'not json'],
		['truncated JSON', NETHERNET_BODY.slice(0, -1)],
		['an array', '[]'],
		['an unrelated object', '{"status":"ok"}'],
		[
			'a non-numeric player count',
			JSON.stringify({ ...JSON.parse(NETHERNET_BODY), players: '1' }),
		],
		[
			'a negative player count',
			JSON.stringify({ ...JSON.parse(NETHERNET_BODY), players: -1 }),
		],
	])('rejects %s', (_label, body) => {
		expect(parseNetherNetStatus(body)).toBeNull()
	})
})

describe('HTTP response reading', () => {
	test('returns the body of a 2xx response', () => {
		expect(readSuccessfulHttpBody(Buffer.from(httpResponse('{}')))).toBe('{}')
	})

	test('decodes chunked bodies', () => {
		const response =
			'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{"\r\n1\r\n}\r\n0\r\n\r\n'

		expect(readSuccessfulHttpBody(Buffer.from(response))).toBe('{"}')
	})

	test('rejects other statuses and incomplete headers', () => {
		expect(
			readSuccessfulHttpBody(Buffer.from(httpResponse('{}', '404 Not Found'))),
		).toBeNull()
		expect(
			readSuccessfulHttpBody(Buffer.from(httpResponse('{}', '302 Found'))),
		).toBeNull()
		expect(
			readSuccessfulHttpBody(Buffer.from('HTTP/1.1 200 OK\r\n')),
		).toBeNull()
	})
})

describe('transport merging', () => {
	const raknet = {
		edition: 'MCPE',
		gamemode: 'Creative',
		geyserDetected: true,
		latencyMs: 10,
		mapName: 'RakNet level',
		motd: 'RakNet',
		online: true,
		port: 19_133,
		serverId: 'id',
		version: '1.0',
	}
	const nethernet = {
		geyserDetected: false,
		latencyMs: 20,
		motd: 'NetherNet',
		online: true,
		version: '1.26.60',
	}

	test('uses whichever transport answered', () => {
		expect(mergeTransportResults(raknet, null)).toEqual(raknet)
		expect(mergeTransportResults(null, nethernet)).toEqual(nethernet)
		expect(mergeTransportResults(null, null)).toBeNull()
	})

	test('prefers NetherNet values and keeps RakNet-only ones', () => {
		expect(mergeTransportResults(raknet, nethernet)).toEqual({
			edition: 'MCPE',
			gamemode: 'Creative',
			geyserDetected: true,
			latencyMs: 10,
			mapName: 'RakNet level',
			motd: 'NetherNet',
			online: true,
			port: 19_133,
			serverId: 'id',
			version: '1.26.60',
		})
	})
})

describe('probing a server', () => {
	const cleanups: Array<() => void> = []

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup()
		}
	})

	/** A TCP server standing in for NetherNet signaling. */
	async function startSignaling(
		onRequest: (request: string, socket: net.Socket) => void,
		port = 0,
	) {
		const sockets = new Set<net.Socket>()
		const server = net.createServer((socket) => {
			sockets.add(socket)
			socket.on('error', () => {})
			socket.on('close', () => sockets.delete(socket))
			socket.once('data', (data) => onRequest(data.toString(), socket))
		})
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			server.listen(port, '127.0.0.1', () => {
				server.off('error', reject)
				resolve()
			})
		})
		cleanups.push(() => {
			for (const socket of sockets) {
				socket.destroy()
			}
			server.close()
		})
		return (server.address() as net.AddressInfo).port
	}

	/** A UDP socket answering RakNet pings, on the signaling port if given. */
	async function startRakNet(port = 0) {
		const socket = dgram.createSocket('udp4')
		socket.on('message', (_message, remote) => {
			socket.send(
				createPong('MCPE;RakNet;1;1.0;2;100;id;Level;Creative', 1n),
				remote.port,
				remote.address,
			)
		})
		await new Promise<void>((resolve, reject) => {
			socket.once('error', reject)
			socket.bind(port, '127.0.0.1', () => {
				socket.off('error', reject)
				resolve()
			})
		})
		cleanups.push(() => socket.close())
		return socket.address().port
	}

	/**
	 * Both transports on one port, like a real server. Windows reserves blocks of
	 * ports inside the range the OS allocates from, per protocol, so a port handed
	 * out for one protocol can be refused for the other. Picking from below that
	 * range avoids the blocks; a port that happens to be taken is simply skipped.
	 */
	async function startBothTransports(
		onRequest: (request: string, socket: net.Socket) => void,
	) {
		for (let attempt = 1; ; attempt += 1) {
			const port = 20_000 + Math.floor(Math.random() * 25_000)
			try {
				await startSignaling(onRequest, port)
				return await startRakNet(port)
			} catch (error) {
				if (attempt === 20) {
					throw error
				}
			}
		}
	}

	const target = {
		address: '127.0.0.1',
		family: 4 as const,
		host: 'example.com',
	}

	test('reads NetherNet status from the validated address', async () => {
		let request = ''
		const port = await startSignaling((received, socket) => {
			request = received
			socket.end(httpResponse(NETHERNET_BODY))
		})

		const result = await queryNetherNetStatus(target, port, 1000)

		expect(result?.motd).toBe('Halloween')
		expect(result?.latencyMs).toBeGreaterThanOrEqual(1)
		expect(request).toStartWith('GET /v1/join HTTP/1.1\r\n')
		expect(request).toContain(`Host: example.com:${port}\r\n`)
	})

	test('finishes without waiting for the connection to close', async () => {
		const port = await startSignaling((_request, socket) => {
			socket.write(httpResponse(NETHERNET_BODY))
		})
		const startedAt = performance.now()

		expect(await queryNetherNetStatus(target, port, 3000)).not.toBeNull()
		expect(performance.now() - startedAt).toBeLessThan(2000)
	})

	test('does not follow redirects', async () => {
		let requests = 0
		const redirectTarget = await startSignaling((_request, socket) => {
			requests += 1
			socket.end(httpResponse(NETHERNET_BODY))
		})
		const port = await startSignaling((_request, socket) => {
			socket.end(
				`HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${redirectTarget}/\r\nContent-Length: 0\r\n\r\n`,
			)
		})

		expect(await queryNetherNetStatus(target, port, 1000)).toBeNull()
		expect(requests).toBe(0)
	})

	test('rejects oversized responses', async () => {
		const padded = JSON.stringify({
			...JSON.parse(NETHERNET_BODY),
			padding: 'x'.repeat(20_000),
		})
		const port = await startSignaling((_request, socket) => {
			socket.end(httpResponse(padded))
		})

		expect(await queryNetherNetStatus(target, port, 1000)).toBeNull()
	})

	test('gives up on a server that never responds', async () => {
		const port = await startSignaling(() => {})
		const startedAt = performance.now()

		expect(await queryNetherNetStatus(target, port, 200)).toBeNull()
		expect(performance.now() - startedAt).toBeLessThan(1000)
	})

	test('reports a NetherNet-only server as online', async () => {
		const port = await startSignaling((_request, socket) => {
			socket.end(httpResponse(NETHERNET_BODY))
		})

		expect(await probeBedrockTarget(target, port, 1000)).toMatchObject({
			motd: 'Halloween',
			online: true,
			playerCount: 1,
			port,
		})
	})

	test('reports a RakNet-only server as online', async () => {
		const port = await startRakNet()

		expect(await probeBedrockTarget(target, port, 2000)).toMatchObject({
			motd: 'RakNet',
			online: true,
			playerCount: 2,
			port,
		})
	})

	test('merges a server answering both without waiting for the timeout', async () => {
		const port = await startBothTransports((_request, socket) => {
			socket.end(httpResponse(NETHERNET_BODY))
		})
		const startedAt = performance.now()

		expect(await probeBedrockTarget(target, port, 3000)).toMatchObject({
			motd: 'Halloween',
			online: true,
			serverId: 'id',
		})
		expect(performance.now() - startedAt).toBeLessThan(2000)
	})

	test('keeps the first answer when the other transport stays silent', async () => {
		const port = await startBothTransports(() => {})
		const startedAt = performance.now()

		expect(await probeBedrockTarget(target, port, 3000)).toMatchObject({
			motd: 'RakNet',
			online: true,
		})
		expect(performance.now() - startedAt).toBeLessThan(2000)
	})

	test('reports offline when neither transport answers', async () => {
		const port = await startSignaling((_request, socket) => {
			socket.end(httpResponse('{}', '404 Not Found'))
		})

		expect(await probeBedrockTarget(target, port, 300)).toEqual({
			online: false,
		})
	})

	test('still refuses private targets before any traffic', async () => {
		expect(pingBedrockServer('127.0.0.1')).rejects.toBeInstanceOf(
			PublicTargetError,
		)
	})
})
