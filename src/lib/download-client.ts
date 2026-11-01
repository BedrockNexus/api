import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

export function downloadClientKey(
	secret: string,
	headers: Headers,
	options: {
		trustProxyHeaders: boolean
		clientIpHeader?: string
		trustedProxyHops?: number
	},
) {
	let address = 'unknown'
	if (options.trustProxyHeaders) {
		const trusted = options.clientIpHeader
			? headers.get(options.clientIpHeader)?.trim()
			: undefined
		const forwarded = headers
			.get('x-forwarded-for')
			?.split(',')
			.map((part) => part.trim())
			.filter(Boolean)
		const hops = Math.max(1, options.trustedProxyHops ?? 1)
		const candidate =
			trusted ||
			forwarded?.[Math.max((forwarded?.length ?? 0) - hops, 0)] ||
			headers.get('x-real-ip')?.trim()
		if (candidate && isIP(candidate)) address = candidate
	}
	return createHash('sha256')
		.update(`${secret}\0client\0${address}`)
		.digest('hex')
}
