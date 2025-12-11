import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import minecraft from './routes/minecraft'

const app = new Hono()

// Middleware
app.use('*', logger())
app.use('*', cors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}))

// Health check
app.get('/', (c) => {
  return c.json({ 
    status: 'ok', 
    service: 'BedrockNexus API',
    version: '1.0.0'
  })
})

app.get('/health', (c) => {
  return c.json({ status: 'healthy' })
})

// Routes
app.route('/api/minecraft', minecraft)

// Start server
const port = parseInt(process.env.PORT || '3001', 10)

console.log(`🚀 BedrockNexus API running on http://localhost:${port}`)

export default {
  port,
  fetch: app.fetch,
}
