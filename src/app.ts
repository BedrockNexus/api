import { isIP } from 'node:net'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { rateLimiter } from 'hono-rate-limiter'
import type { AppConfig } from './config'
import { loadAppConfig } from './config'
import { createConvexMutation } from './lib/convex-mutation'
import { createConvexQuery } from './lib/convex-query'
import { downloadClientKey } from './lib/download-client'
import { hasValidApiKey } from './middleware/api-key'
import { concurrencyLimit } from './middleware/concurrency-limit'
import { createCatalogRoutes } from './routes/catalog'
import minecraft from './routes/minecraft'
import { createServerVerificationRoutes } from './routes/server-verify'

function getClientKey(c: Context, trustProxyHeaders: boolean) {
	if (!trustProxyHeaders) {
		return 'global'
	}

	const forwardedAddress =
		c.req.header('cf-connecting-ip') ??
		c.req.header('x-forwarded-for')?.split(',')[0]?.trim()

	return forwardedAddress && isIP(forwardedAddress)
		? forwardedAddress
		: 'unknown'
}

export function createApp(config: AppConfig = loadAppConfig()) {
	const app = new Hono()
	const internalRequest = (c: Context) =>
		hasValidApiKey(c.req.header('X-API-Key'), config.apiKey)

	const statusLimiter = rateLimiter({
		keyGenerator: (c) => getClientKey(c, config.trustProxyHeaders),
		limit: config.statusRateLimit,
		message: { error: 'Too many server status requests' },
		skip: internalRequest,
		standardHeaders: 'draft-6',
		windowMs: 60_000,
	})
	const catalogLimiter = rateLimiter({
		keyGenerator: (c) => getClientKey(c, config.trustProxyHeaders),
		limit: config.catalogRateLimit,
		message: {
			error: {
				code: 'RATE_LIMITED',
				message: 'Too many catalog requests, please try again later',
			},
		},
		skip: internalRequest,
		standardHeaders: 'draft-6',
		windowMs: 60_000,
	})
	const generalLimiter = rateLimiter({
		keyGenerator: (c) => getClientKey(c, config.trustProxyHeaders),
		limit: config.generalRateLimit,
		message: { error: 'Too many requests, please try again later' },
		skip: (c) =>
			c.req.path === '/' ||
			c.req.path === '/health' ||
			c.req.path === '/minecraft/status' ||
			c.req.path.startsWith('/v1/') ||
			internalRequest(c),
		standardHeaders: 'draft-6',
		windowMs: 60_000,
	})

	app.use('*', logger())
	// The catalog is read-only public data without credentials, so any site may
	// read it. Registered first because the general policy answers preflights.
	app.use(
		'/v1/*',
		cors({
			allowMethods: ['GET', 'POST', 'OPTIONS'],
			maxAge: 600,
			origin: '*',
		}),
	)
	app.use(
		'*',
		cors({
			allowHeaders: ['Content-Type', 'X-API-Key'],
			allowMethods: ['GET', 'POST', 'OPTIONS'],
			maxAge: 600,
			origin:
				config.corsOrigins === '*'
					? '*'
					: (origin) =>
							config.corsOrigins.includes(origin) ? origin : undefined,
		}),
	)
	app.use('/minecraft/status', statusLimiter)
	// Scheduled checks from the Hub arrive in bursts; they wait for a slot so a
	// busy moment is never reported back as a failed check.
	app.use(
		'/minecraft/status',
		concurrencyLimit(config.maxConcurrentStatusChecks, {
			maxQueued: config.maxQueuedStatusChecks,
			shouldQueue: internalRequest,
		}),
	)
	app.use('/v1/*', catalogLimiter)
	app.use('*', generalLimiter)

	app.get('/', (c) =>
		c.json({
			service: 'BedrockNexus API',
			status: 'ok',
			version: '1.0.0',
		}),
	)
	app.get('/health', (c) => c.json({ status: 'healthy' }))

	app.route('/minecraft', minecraft)
	app.route('/server-verify', createServerVerificationRoutes(config.apiKey))
	app.route(
		'/v1',
		createCatalogRoutes({
			apiUrl: config.apiUrl,
			downloadSecret: config.downloadRedirectSecret,
			mutation: config.convexUrl
				? createConvexMutation(config.convexUrl)
				: undefined,
			clientKey: (headers) =>
				downloadClientKey(config.downloadRedirectSecret ?? '', headers, config),
			hubUrl: config.hubUrl,
			query: config.convexUrl ? createConvexQuery(config.convexUrl) : undefined,
		}),
	)

	app.notFound((c) => c.json({ error: 'Not found' }, 404))
	app.onError((error, c) => {
		console.error('Unhandled API error', error)
		return c.json({ error: 'Internal server error' }, 500)
	})

	return app
}
