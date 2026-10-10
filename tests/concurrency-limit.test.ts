import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { concurrencyLimit } from '../src/middleware/concurrency-limit'

/** An app whose handler stays busy until the returned `finish` is called. */
function createBlockingApp(maxConcurrent: number, maxQueued: number) {
	const pending: Array<() => void> = []
	const app = new Hono()
	app.use(
		'*',
		concurrencyLimit(maxConcurrent, {
			maxQueued,
			shouldQueue: (c) => c.req.header('X-Internal') === 'yes',
		}),
	)
	app.get('/', async (c) => {
		await new Promise<void>((resolve) => pending.push(resolve))
		return c.json({ ok: true })
	})

	return {
		app,
		finish: () => pending.shift()?.(),
		started: () => pending.length,
	}
}

const internal = { headers: { 'X-Internal': 'yes' } }
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('concurrency limit', () => {
	test('rejects public requests when every slot is busy', async () => {
		const { app, finish } = createBlockingApp(1, 5)
		const first = app.request('/')
		await settle()

		const rejected = await app.request('/')
		expect(rejected.status).toBe(503)
		expect(rejected.headers.get('Retry-After')).toBe('1')

		finish()
		expect((await first).status).toBe(200)
	})

	test('queues internal requests until a slot frees up', async () => {
		const { app, finish, started } = createBlockingApp(1, 5)
		const first = app.request('/')
		await settle()
		const queued = app.request('/', internal)
		await settle()
		// Still waiting: the handler has only been entered once.
		expect(started()).toBe(1)

		finish()
		await settle()
		expect(started()).toBe(1)
		finish()

		expect((await first).status).toBe(200)
		expect((await queued).status).toBe(200)
	})

	test('rejects internal requests once the queue is full', async () => {
		const { app, finish } = createBlockingApp(1, 1)
		const first = app.request('/')
		await settle()
		const queued = app.request('/', internal)
		await settle()

		const overflow = await app.request('/', internal)
		expect(overflow.status).toBe(503)

		finish()
		await settle()
		finish()
		await Promise.all([first, queued])
	})

	test('frees the slot again after queued work finishes', async () => {
		const { app, finish } = createBlockingApp(1, 1)
		const first = app.request('/')
		await settle()
		const queued = app.request('/', internal)
		await settle()
		finish()
		await settle()
		finish()
		await Promise.all([first, queued])

		const next = app.request('/')
		await settle()
		finish()
		expect((await next).status).toBe(200)
	})
})
