export interface AppConfig {
	apiKey?: string
	artifactAllowedHosts: string[]
	corsOrigins: '*' | string[]
	generalRateLimit: number
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
		apiKey,
		artifactAllowedHosts:
			process.env.ARTIFACT_ALLOWED_HOSTS?.split(',')
				.map((host) => host.trim().toLowerCase())
				.filter(Boolean) ?? [],
		corsOrigins: readCorsOrigins(),
		generalRateLimit: readPositiveInteger('GENERAL_RATE_LIMIT', 60),
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
