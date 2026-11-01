export interface AppConfig {
	apiUrl?: string
	downloadRedirectSecret?: string
	clientIpHeader?: string
	trustedProxyHops?: number
	apiKey?: string
	artifactAllowedHosts: string[]
	catalogRateLimit: number
	convexUrl?: string
	corsOrigins: '*' | string[]
	generalRateLimit: number
	hubUrl: string
	maxConcurrentStatusChecks: number
	maxQueuedStatusChecks: number
	statusRateLimit: number
	trustProxyHeaders: boolean
}

function readPositiveInteger(name: string, fallback: number) {
	const rawValue = process.env[name]
	if (!rawValue) {
		return fallback
	}

	const value = Number.parseInt(rawValue, 10)
	return Number.isInteger(value) && value > 0 ? value : fallback
}

function readBoolean(name: string, fallback: boolean) {
	const rawValue = process.env[name]?.trim().toLowerCase()
	if (!rawValue) {
		return fallback
	}
	return rawValue === 'true' || rawValue === '1'
}

function readCorsOrigins(): '*' | string[] {
	const origins = process.env.CORS_ORIGINS?.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean)

	return origins?.length ? origins : '*'
}

export function loadAppConfig(): AppConfig {
	const apiKey = process.env.API_SECRET_KEY?.trim() || undefined

	if (process.env.NODE_ENV === 'production' && !apiKey) {
		throw new Error('API_SECRET_KEY is required in production')
	}

	return {
		apiUrl:
			process.env.API_PUBLIC_URL?.trim() || 'https://api.bedrocknexus.com',
		downloadRedirectSecret:
			process.env.DOWNLOAD_REDIRECT_SECRET?.trim() || undefined,
		clientIpHeader:
			process.env.CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
		trustedProxyHops: readPositiveInteger('TRUSTED_PROXY_HOPS', 1),
		apiKey,
		artifactAllowedHosts:
			process.env.ARTIFACT_ALLOWED_HOSTS?.split(',')
				.map((host) => host.trim().toLowerCase())
				.filter(Boolean) ?? [],
		catalogRateLimit: readPositiveInteger('CATALOG_RATE_LIMIT', 120),
		convexUrl: process.env.CONVEX_URL?.trim() || undefined,
		corsOrigins: readCorsOrigins(),
		generalRateLimit: readPositiveInteger('GENERAL_RATE_LIMIT', 60),
		hubUrl: process.env.HUB_URL?.trim() || 'https://bedrocknexus.com',
		maxConcurrentStatusChecks: readPositiveInteger(
			'MAX_CONCURRENT_STATUS_CHECKS',
			25,
		),
		maxQueuedStatusChecks: readPositiveInteger(
			'MAX_QUEUED_STATUS_CHECKS',
			1000,
		),
		statusRateLimit: readPositiveInteger('STATUS_RATE_LIMIT', 30),
		trustProxyHeaders: readBoolean('TRUST_PROXY_HEADERS', false),
	}
}
