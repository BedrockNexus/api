import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
	ARTIFACT_TYPES,
	type ArtifactType,
	validateArtifact,
} from '../lib/artifact-validator'
import { validateRemoteMap } from '../lib/remote-map-validator'
import { requireApiKey } from '../middleware/api-key'
import { concurrencyLimit } from '../middleware/concurrency-limit'

interface ValidationBody {
	type?: unknown
	fileName?: unknown
	fileSize?: unknown
	downloadUrl?: unknown
}

export function createArtifactValidationRoutes(args: {
	apiKey?: string
	allowedHosts: string[]
	enableMaps?: boolean
}) {
	const app = new Hono()
	app.use('*', requireApiKey(args.apiKey))
	app.use(
		'*',
		bodyLimit({
			maxSize: 16 * 1024,
			onError: (c) => c.json({ error: 'Validation request is too large' }, 413),
		}),
	)
	app.post('/', async (c) => {
		let body: ValidationBody
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'A valid JSON body is required' }, 400)
		}
		if (
			typeof body.type !== 'string' ||
			!ARTIFACT_TYPES.includes(body.type as ArtifactType) ||
			typeof body.fileName !== 'string' ||
			typeof body.fileSize !== 'number' ||
			typeof body.downloadUrl !== 'string'
		) {
			return c.json({ error: 'Invalid validation request' }, 400)
		}

		const result = await validateArtifact(
			{
				type: body.type as ArtifactType,
				fileName: body.fileName,
				fileSize: body.fileSize,
				downloadUrl: body.downloadUrl,
			},
			args.allowedHosts,
		)
		if (!result.valid && result.code === 'VALIDATOR_UNAVAILABLE') {
			return c.json(result, 503)
		}
		return c.json(result)
	})
	app.use('/maps', concurrencyLimit(1))
	app.post('/maps', async (c) => {
		if (!args.enableMaps)
			return c.json({ error: 'Maps validation is not enabled' }, 404)
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'A valid JSON body is required' }, 400)
		}
		if (!body || typeof body !== 'object')
			return c.json({ error: 'Invalid Maps request' }, 400)
		const value = body as Record<string, unknown>
		if (
			value.type !== 'map' ||
			typeof value.fileName !== 'string' ||
			typeof value.fileSize !== 'number' ||
			typeof value.downloadUrl !== 'string' ||
			typeof value.sourceEtag !== 'string'
		)
			return c.json({ error: 'Invalid Maps request' }, 400)
		const result = await validateRemoteMap(
			{
				fileName: value.fileName,
				fileSize: value.fileSize,
				downloadUrl: value.downloadUrl,
				sourceEtag: value.sourceEtag,
			},
			args.allowedHosts,
		)
		return c.json(
			result,
			!result.valid && result.code === 'VALIDATOR_UNAVAILABLE' ? 503 : 200,
		)
	})
	return app
}
