import { describe, expect, test } from 'bun:test'
import { detectGeyserFromMotd, parseBedrockPong } from '../src/lib/bedrock-ping'

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
