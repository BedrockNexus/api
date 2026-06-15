import type { BedrockServerInfo } from './bedrock-ping'
import { type JavaServerStatus, probeJavaServers } from './java-status'

const CACHE_TTL_MS = 10 * 60 * 1000
const JAVA_PROXY_PATTERN =
	/\b(?:bungeecord|flamecord|gate|velocity|waterfall)\b/i

export type ServerSoftwareClassification =
	| 'ambiguous'
	| 'geyser_likely'
	| 'native_bedrock'

export interface SoftwareInspection {
	classification: ServerSoftwareClassification
	javaServers: JavaServerStatus[]
	reasons: string[]
	score: number
}

interface CacheEntry {
	expiresAt: number
	result: Promise<SoftwareInspection>
}

const inspectionCache = new Map<string, CacheEntry>()

function normalizeText(value: string) {
	return value
		.normalize('NFKC')
		.replaceAll(/§./g, '')
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
}

function textSimilarity(left: string, right: string) {
	const leftTokens = new Set(
		normalizeText(left)
			.split(' ')
			.filter((token) => token.length > 1),
	)
	const rightTokens = new Set(
		normalizeText(right)
			.split(' ')
			.filter((token) => token.length > 1),
	)

	if (!(leftTokens.size && rightTokens.size)) {
		return 0
	}

	let intersection = 0
	for (const token of leftTokens) {
		if (rightTokens.has(token)) {
			intersection += 1
		}
	}
	return intersection / new Set([...leftTokens, ...rightTokens]).size
}

export function correlateJavaAndBedrock(
	bedrock: BedrockServerInfo,
	javaServers: JavaServerStatus[],
): SoftwareInspection {
	if (bedrock.geyserDetected) {
		return {
			classification: 'geyser_likely',
			javaServers,
			reasons: ['The Bedrock MOTD contains explicit Geyser branding'],
			score: 10,
		}
	}

	if (!javaServers.length) {
		return {
			classification: 'native_bedrock',
			javaServers,
			reasons: ['No Java status endpoint was detected'],
			score: 0,
		}
	}

	const bedrockMotd = [bedrock.motd, bedrock.mapName].filter(Boolean).join(' ')
	let bestScore = 0
	let bestReasons: string[] = []

	for (const java of javaServers) {
		let score = 0
		const reasons: string[] = []
		const similarity = textSimilarity(bedrockMotd, java.motd)

		if (similarity >= 0.6) {
			score += 4
			reasons.push('Java and Bedrock MOTDs strongly match')
		} else if (similarity >= 0.3) {
			score += 2
			reasons.push('Java and Bedrock MOTDs partially match')
		}

		if (
			bedrock.maxPlayers !== undefined &&
			bedrock.maxPlayers > 0 &&
			bedrock.maxPlayers === java.maxPlayers
		) {
			score += 2
			reasons.push('Java and Bedrock player capacities match')
		}

		if (
			bedrock.playerCount !== undefined &&
			Math.abs(bedrock.playerCount - java.playerCount) <=
				Math.max(5, Math.ceil(java.maxPlayers * 0.02))
		) {
			score += 2
			reasons.push('Java and Bedrock player counts are synchronized')
		}

		if (java.versionName && JAVA_PROXY_PATTERN.test(java.versionName)) {
			score += 2
			reasons.push(`Java endpoint reports ${java.versionName}`)
		}

		if (score > bestScore) {
			bestScore = score
			bestReasons = reasons
		}
	}

	return {
		classification: bestScore >= 5 ? 'geyser_likely' : 'ambiguous',
		javaServers,
		reasons:
			bestReasons.length > 0
				? bestReasons
				: ['A Java endpoint exists but does not clearly match Bedrock'],
		score: bestScore,
	}
}

export async function inspectServerSoftware(
	host: string,
	port: number,
	bedrock: BedrockServerInfo,
) {
	const cacheKey = `${host.toLowerCase()}:${port}`
	const cached = inspectionCache.get(cacheKey)
	if (cached && cached.expiresAt > Date.now()) {
		return await cached.result
	}

	const result = probeJavaServers(host, port).then((javaServers) =>
		correlateJavaAndBedrock(bedrock, javaServers),
	)
	inspectionCache.set(cacheKey, {
		expiresAt: Date.now() + CACHE_TTL_MS,
		result,
	})

	try {
		return await result
	} catch (error) {
		inspectionCache.delete(cacheKey)
		throw error
	}
}
