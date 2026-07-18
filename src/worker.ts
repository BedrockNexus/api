import { loadAppConfig } from './config'
import { createWorkerApp } from './worker-app'

const config = loadAppConfig()
if (
	process.env.NODE_ENV === 'production' &&
	config.artifactAllowedHosts.length === 0
) {
	throw new Error('ARTIFACT_ALLOWED_HOSTS is required for the validator worker')
}
const app = createWorkerApp(config)
const port = Number.parseInt(process.env.PORT ?? '3002', 10)

console.log(`BedrockNexus artifact validator listening on port ${port}`)

export default { fetch: app.fetch, port }
