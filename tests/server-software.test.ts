import { describe, expect, test } from 'bun:test'
import type { BedrockServerInfo } from '../src/lib/bedrock-ping'
import type { JavaServerStatus } from '../src/lib/java-status'
import { correlateJavaAndBedrock } from '../src/lib/server-software'

const bedrockServer: BedrockServerInfo = {
	edition: 'MCPE',
	gamemode: 'Survival',
	geyserDetected: false,
	mapName: 'Clans Pixelmon Network Quests',
	maxPlayers: 3000,
	motd: 'Complex Gaming',
	online: true,
	playerCount: 1439,
	port: 19_132,
	protocolVersion: 1001,
	version: '26.30',
}

function javaServer(
	overrides: Partial<JavaServerStatus> = {},
): JavaServerStatus {
	return {
		address: '203.0.113.10',
		host: 'play.example.com',
		maxPlayers: 3000,
		motd: 'Complex Gaming Clans Pixelmon Network Quests',
		online: true,
		playerCount: 1431,
		port: 25_565,
		protocolVersion: 47,
		versionName: 'Velocity 1.7.2-26.1',
		...overrides,
	}
}

describe('server software correlation', () => {
	test('classifies Bedrock-only servers as native', () => {
		const result = correlateJavaAndBedrock(bedrockServer, [])

		expect(result.classification).toBe('native_bedrock')
		expect(result.score).toBe(0)
	})

	test('classifies matching Java and Bedrock responses as likely Geyser', () => {
		const result = correlateJavaAndBedrock(bedrockServer, [javaServer()])

		expect(result.classification).toBe('geyser_likely')
		expect(result.score).toBeGreaterThanOrEqual(5)
		expect(result.reasons).toContain('Java and Bedrock player capacities match')
	})

	test('classifies unrelated Java and Bedrock servers as ambiguous', () => {
		const result = correlateJavaAndBedrock(bedrockServer, [
			javaServer({
				maxPlayers: 50,
				motd: 'Unrelated Java Lobby',
				playerCount: 2,
				versionName: 'Paper 1.21.4',
			}),
		])

		expect(result.classification).toBe('ambiguous')
		expect(result.score).toBeLessThan(5)
	})

	test('explicit Geyser branding is sufficient without Java correlation', () => {
		const result = correlateJavaAndBedrock(
			{ ...bedrockServer, geyserDetected: true },
			[],
		)

		expect(result.classification).toBe('geyser_likely')
		expect(result.score).toBe(10)
	})
})
