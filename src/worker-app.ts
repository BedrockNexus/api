import { Hono } from 'hono'
import type { AppConfig } from './config'
import { loadAppConfig } from './config'
import { createArtifactValidationRoutes } from './routes/artifact-validate'

export function createWorkerApp(config: AppConfig = loadAppConfig()) {
	const app = new Hono()
	app.get('/health', (c) =>
		c.json({ status: 'healthy', service: 'artifact-validator' }),
	)
	app.route(
		'/artifact-validate',
		createArtifactValidationRoutes({
			apiKey: config.apiKey,
			allowedHosts: config.artifactAllowedHosts,
		}),
	)
	app.notFound((c) => c.json({ error: 'Not found' }, 404))
	return app
}
