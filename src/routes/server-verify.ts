import { Hono } from 'hono'

const app = new Hono()

// Generate verification code (public)
app.get('/', async (c) => {
	const action = c.req.query('action')

	if (action === 'generate-code') {
		const code = Math.random().toString(36).substring(2, 10).toUpperCase()
		return c.json({ code })
	}

	if (action === 'verify') {
		const ip = c.req.query('ip')
		const code = c.req.query('code')

		if (!ip || !code) {
			return c.json({ error: 'IP and code are required' }, 400)
		}

		try {
			const expectedRecord = `bedrocknexus-verify=${code}`
			const response = await fetch(
				`https://dns.google/resolve?name=${encodeURIComponent(ip)}&type=TXT`,
			)

			if (!response.ok) {
				return c.json({ verified: false, error: 'DNS lookup failed' }, 500)
			}

			const data = (await response.json()) as {
				Answer?: Array<{ data?: string }>
			}

			if (!data.Answer || data.Answer.length === 0) {
				return c.json({ verified: false, error: 'No TXT records found' })
			}

			const verified = data.Answer.some((record) => {
				const recordData = record.data?.replace(/"/g, '') || ''
				return recordData === expectedRecord
			})

			return c.json({ verified })
		} catch {
			return c.json({ verified: false, error: 'Verification failed' }, 500)
		}
	}

	return c.json({ error: 'Invalid action' }, 400)
})

export default app
