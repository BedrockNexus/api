import { Hono } from 'hono'
import { ConvexHttpClient } from 'convex/browser'

const app = new Hono()

const convexUrl = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL

function parseLimit(
	value: string | null | undefined,
	max = 1000,
): number | undefined {
	if (!value) {
		return undefined
	}
	const parsed = Number.parseInt(value, 10)
	if (!Number.isFinite(parsed)) {
		return undefined
	}
	return Math.min(Math.max(parsed, 1), max)
}

function getClient() {
	if (!convexUrl) {
		return null
	}
	return new ConvexHttpClient(convexUrl)
}

async function convexQuery<T>(
	client: ConvexHttpClient,
	path: string,
	args: Record<string, unknown>,
): Promise<T> {
	return (client as unknown as { query: (p: string, a: unknown) => Promise<T> })
		.query(path, args)
}

async function convexMutation<T>(
	client: ConvexHttpClient,
	path: string,
	args: Record<string, unknown>,
): Promise<T> {
	return (client as unknown as { mutation: (p: string, a: unknown) => Promise<T> })
		.mutation(path, args)
}

app.get('/leaderboard', async (c) => {
	const client = getClient()
	if (!client) {
		return c.json({ error: 'Missing CONVEX_URL' }, 500)
	}

	const serverId = c.req.query('serverId')
	const limit = parseLimit(c.req.query('limit'))

	if (!serverId) {
		return c.json({ error: 'serverId is required' }, 400)
	}

	try {
		const result = await convexQuery(
			client,
			'functions/servers/votes:listServerVoters',
			{
				serverId,
				limit,
			},
		)
		return c.json(result)
	} catch (error) {
		console.error('Vote leaderboard failed', error)
		return c.json({ error: 'Failed to fetch leaderboard' }, 500)
	}
})

app.get('/monthly-leaderboard', async (c) => {
	const client = getClient()
	if (!client) {
		return c.json({ error: 'Missing CONVEX_URL' }, 500)
	}

	const serverId = c.req.query('serverId')
	if (!serverId) {
		return c.json({ error: 'serverId is required' }, 400)
	}

	try {
		const result = await convexQuery(
			client,
			'functions/servers/votes:getServerVotesThisMonth',
			{ serverId },
		)
		return c.json(result)
	} catch (error) {
		console.error('Monthly votes failed', error)
		return c.json({ error: 'Failed to fetch monthly votes' }, 500)
	}
})

app.get('/has-voted', async (c) => {
	const client = getClient()
	if (!client) {
		return c.json({ error: 'Missing CONVEX_URL' }, 500)
	}

	const serverId = c.req.query('serverId')
	const username = c.req.query('username')

	if (!serverId || !username) {
		return c.json({ error: 'serverId and username are required' }, 400)
	}

	try {
		const result = await convexQuery(
			client,
			'functions/servers/votes:hasUsernameVoted',
			{
				serverId,
				username,
			},
		)
		return c.json(result)
	} catch (error) {
		console.error('Has-voted lookup failed', error)
		return c.json({ error: 'Failed to check vote status' }, 500)
	}
})

app.post('/submit', async (c) => {
	const client = getClient()
	if (!client) {
		return c.json({ error: 'Missing CONVEX_URL' }, 500)
	}

	let body: { serverId?: string; username?: string; anonymousId?: string } = {}
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const { serverId, username, anonymousId } = body
	if (!serverId || !username) {
		return c.json({ error: 'serverId and username are required' }, 400)
	}

	try {
		const result = await convexMutation(client, 'functions/servers/votes:vote', {
			serverId,
			username,
			anonymousId,
		})
		return c.json(result)
	} catch (error) {
		console.error('Vote submit failed', error)
		return c.json({ error: 'Failed to submit vote' }, 500)
	}
})

app.post('/claim', async (c) => {
	const client = getClient()
	if (!client) {
		return c.json({ error: 'Missing CONVEX_URL' }, 500)
	}

	let body: { serverId?: string; username?: string } = {}
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const { serverId, username } = body
	if (!serverId || !username) {
		return c.json({ error: 'serverId and username are required' }, 400)
	}

	try {
		const result = await convexMutation(
			client,
			'functions/servers/votes:claimVote',
			{
				serverId,
				username,
			},
		)
		return c.json(result)
	} catch (error) {
		console.error('Vote claim failed', error)
		return c.json({ error: 'Failed to claim vote' }, 500)
	}
})

export default app
