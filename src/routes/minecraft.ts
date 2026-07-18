import { Hono } from 'hono'
import { pingBedrockServer } from '../lib/bedrock-ping'
import { PublicTargetError } from '../lib/public-target'
import {
	parsePort,
	parseTimeout,
	RequestValidationError,
} from '../lib/request-validation'
import { inspectServerSoftware } from '../lib/server-software'

const app = new Hono()

// Query Bedrock server status
app.get('/status', async (c) => {
	const host = c.req.query('ip')?.trim()
	if (!host) {
		return c.json({ error: 'IP address or hostname is required' }, 400)
	}

	try {
		const port = parsePort(c.req.query('port'))
		const timeout = parseTimeout(c.req.query('timeout'))
		const startedAt = performance.now()
		const result = await pingBedrockServer(host, port, timeout)
		const latencyMs = Math.max(1, Math.round(performance.now() - startedAt))

		if (!result.online) {
			return c.json({
				error: 'Server offline or unreachable',
				online: false,
			})
		}
		const software = await inspectServerSoftware(host, port, result)

		return c.json({
			gamemode: result.gamemode ?? '',
			latencyMs,
			mapName: result.mapName ?? '',
			motd: result.motd ?? '',
			online: true,
			players: {
				max: result.maxPlayers ?? 0,
				online: result.playerCount ?? 0,
			},
			port: result.port ?? port,
			protocolVersion: result.protocolVersion ?? 0,
			serverId: result.serverId ?? '',
			software: {
				classification: software.classification,
				javaEndpoints: software.javaServers.map((server) => ({
					host: server.host,
					port: server.port,
					version: server.versionName ?? '',
				})),
				reasons: software.reasons,
			},
			version: result.version ?? '',
		})
	} catch (error) {
		if (
			error instanceof RequestValidationError ||
			error instanceof PublicTargetError
		) {
			return c.json({ error: error.message }, 400)
		}

		console.error('Bedrock status check failed', error)
		return c.json(
			{ error: 'Server offline or unreachable', online: false },
			502,
		)
	}
})

export default app
