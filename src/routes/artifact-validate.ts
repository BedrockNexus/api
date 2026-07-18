import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
	ARTIFACT_TYPES,
	type ArtifactType,
	validateArtifact,
} from '../lib/artifact-validator'
import { requireApiKey } from '../middleware/api-key'

interface ValidationBody {
	type?: unknown
	fileName?: unknown
	fileSize?: unknown
	downloadUrl?: unknown
}

export function createArtifactValidationRoutes(args: {
	apiKey?: string
	allowedHosts: string[]
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

		return c.json(
			await validateArtifact(
				{
					type: body.type as ArtifactType,
					fileName: body.fileName,
					fileSize: body.fileSize,
					downloadUrl: body.downloadUrl,
				},
				args.allowedHosts,
			),
		)
	})
	return app
}
