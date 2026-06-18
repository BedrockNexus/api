import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { pingBedrockServer } from '../lib/bedrock-ping'
import { PublicTargetError, resolvePublicTarget } from '../lib/public-target'
import {
	parsePort,
	parseVerificationCode,
	RequestValidationError,
} from '../lib/request-validation'
import { inspectServerSoftware } from '../lib/server-software'
import { requireApiKey } from '../middleware/api-key'

const VERIFICATION_PREFIX = 'bedrocknexus-verify='
const VERIFICATION_BEDROCK_TIMEOUT_MS = 8000

type VerificationMethod = 'dns_txt' | 'motd_token'

interface VerificationRequest {
	code?: unknown
	host?: unknown
	method?: unknown
	port?: unknown
}

interface VerificationResult {
	error?: string
	verified: boolean
}

async function rejectUnsupportedSoftware(
	host: string,
	port: number,
	server: Awaited<ReturnType<typeof pingBedrockServer>>,
): Promise<VerificationResult | null> {
	const inspection = await inspectServerSoftware(host, port, server)
	if (inspection.classification === 'native_bedrock') {
		return null
	}

	const details = inspection.reasons.join('; ')
	if (inspection.classification === 'geyser_likely') {
		return {
			error: `This appears to be a Java server using Geyser. ${details}`,
			verified: false,
		}
	}

	return {
		error: `This server also exposes Java Edition and could not be confirmed as native Bedrock. ${details}`,
		verified: false,
	}
}

export function generateVerificationCode() {
	return crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()
}

async function verifyDnsRecord(
	host: string,
	port: number,
	code: string,
): Promise<VerificationResult> {
	const target = await resolvePublicTarget(host)
	const expectedRecord = `${VERIFICATION_PREFIX}${code}`
	const response = await fetch(
		`https://dns.google/resolve?name=${encodeURIComponent(target.host)}&type=TXT`,
		{
			headers: { Accept: 'application/dns-json' },
			signal: AbortSignal.timeout(5000),
		},
	)

	if (!response.ok) {
		throw new Error(`DNS lookup failed with status ${response.status}`)
	}

	const data = (await response.json()) as {
		Answer?: Array<{ data?: string }>
	}
	const verified =
		data.Answer?.some((record) => {
			const recordData = record.data?.replaceAll('"', '') ?? ''
			return recordData === expectedRecord
		}) ?? false

	if (!verified) {
		return {
			error: 'The verification token was not found in the TXT records',
			verified: false,
		}
	}

	const server = await pingBedrockServer(
		host,
		port,
		VERIFICATION_BEDROCK_TIMEOUT_MS,
	)
	if (!server.online) {
		return {
			error:
				'The DNS token was found, but the Bedrock server is offline or unreachable',
			verified: false,
		}
	}
	const softwareError = await rejectUnsupportedSoftware(host, port, server)
	if (softwareError) {
		return softwareError
	}

	return { verified: true }
}

async function verifyMotd(
	host: string,
	port: number,
	code: string,
): Promise<VerificationResult> {
	const server = await pingBedrockServer(
		host,
		port,
		VERIFICATION_BEDROCK_TIMEOUT_MS,
	)
	if (!server.online) {
		return {
			error: 'The Bedrock server is offline or unreachable',
			verified: false,
		}
	}
	const expectedToken = `${VERIFICATION_PREFIX}${code}`.toLowerCase()
	const searchableMotd = [server.motd, server.mapName]
		.filter(Boolean)
		.join('\n')
		.toLowerCase()
	const verified = searchableMotd.includes(expectedToken)

	if (!verified) {
		return {
			error: 'The verification token was not found in the server MOTD',
			verified: false,
		}
	}

	return (
		(await rejectUnsupportedSoftware(host, port, server)) ?? {
			verified: true,
		}
	)
}

function readMethod(value: unknown): VerificationMethod {
	if (value !== 'dns_txt' && value !== 'motd_token') {
		throw new RequestValidationError('Invalid verification method')
	}
	return value
}

function readHost(value: unknown) {
	if (typeof value !== 'string' || !value.trim()) {
		throw new RequestValidationError('Server hostname is required')
	}
	return value.trim()
}

function readRequiredPort(value: unknown) {
	if (typeof value !== 'number') {
		throw new RequestValidationError('Server port is required')
	}
	return parsePort(String(value))
}

export function createServerVerificationRoutes(apiKey: string | undefined) {
	const app = new Hono()

	app.use('*', requireApiKey(apiKey))
	app.use(
		'*',
		bodyLimit({
			maxSize: 8192,
			onError: (c) =>
				c.json({ error: 'Verification request is too large' }, 413),
		}),
	)

	app.post('/code', (c) => c.json({ code: generateVerificationCode() }))

	app.post('/check', async (c) => {
		let body: VerificationRequest
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'A valid JSON body is required' }, 400)
		}

		try {
			const host = readHost(body.host)
			const code = parseVerificationCode(body.code)
			const method = readMethod(body.method)
			const port = readRequiredPort(body.port)
			const result =
				method === 'dns_txt'
					? await verifyDnsRecord(host, port, code)
					: await verifyMotd(host, port, code)

			return c.json(result)
		} catch (error) {
			if (
				error instanceof RequestValidationError ||
				error instanceof PublicTargetError
			) {
				return c.json({ error: error.message, verified: false }, 400)
			}

			console.error('Server ownership verification failed', error)
			return c.json(
				{ error: 'Verification service is unavailable', verified: false },
				502,
			)
		}
	})

	return app
}
