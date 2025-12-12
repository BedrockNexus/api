import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { rateLimiter } from 'hono-rate-limiter'
import minecraft from './routes/minecraft'

const app = new Hono()

// Configuration
const websiteUrl = process.env.API_WEBSITE_URL || 'http://localhost:3000'
const corsOrigins = process.env.CORS_ORIGINS?.split(',') || [websiteUrl]

// Middleware
app.use('*', logger())
app.use('*', cors({
  origin: corsOrigins,
  credentials: true,
}))

// Rate limiting - skip for requests with valid API key
const apiKey = process.env.API_SECRET_KEY

app.use('*', async (c, next) => {
  // Skip rate limiting for internal requests with valid API key
  const requestKey = c.req.header('X-API-Key')
  if (requestKey === apiKey) {
    return next()
  }

  // Apply rate limiting for everyone else
  const limiter = rateLimiter({
    windowMs: 60 * 1000, // 1 minute
    limit: 10, // 10 requests per minute
    standardHeaders: 'draft-6',
    keyGenerator: (c) => c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'anonymous',
    message: { error: 'Too many requests, please try again later' },
  })

  return limiter(c, next)
})

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
const apiUrl = process.env.API_WEBSITE_URL ? `${process.env.API_WEBSITE_URL}:${port}` : `http://localhost:${port}`

console.log(`🚀 BedrockNexus API running on ${apiUrl}`)

export default {
  port,
  fetch: app.fetch,
}
