import { createApp } from './app'

const app = createApp()
const port = Number.parseInt(process.env.PORT ?? '3001', 10)

console.log(`BedrockNexus API listening on port ${port}`)

export default {
	fetch: app.fetch,
	port,
}
