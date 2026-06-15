import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

export class PublicTargetError extends Error {}

export interface ResolvedPublicTarget {
	address: string
	family: 4 | 6
	host: string
}

export function isPublicIpAddress(address: string) {
	try {
		const parsed = ipaddr.process(address)
		return parsed.range() === 'unicast'
	} catch {
		return false
	}
}

function normalizeHost(rawHost: string) {
	const host = rawHost.trim().replace(/\.$/, '').toLowerCase()
	if (!host || host.length > 253) {
		throw new PublicTargetError('A valid server hostname is required')
	}

	if (isIP(host)) {
		return host
	}

	if (
		host.includes('://') ||
		/[/?#@\s:[\]]/.test(host) ||
		!host.split('.').every((label) => HOST_LABEL_PATTERN.test(label))
	) {
		throw new PublicTargetError('A valid server hostname is required')
	}

	return host
}

export async function resolvePublicTarget(
	rawHost: string,
): Promise<ResolvedPublicTarget> {
	const host = normalizeHost(rawHost)
	const literalFamily = isIP(host)
	const addresses = literalFamily
		? [{ address: host, family: literalFamily }]
		: await lookup(host, { all: true, verbatim: true }).catch(() => [])

	if (!addresses.length) {
		throw new PublicTargetError('The server hostname could not be resolved')
	}

	if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
		throw new PublicTargetError(
			'Private or reserved network addresses are not allowed',
		)
	}

	const target = addresses.find(({ family }) => family === 4) ?? addresses[0]
	return {
		address: target.address,
		family: target.family as 4 | 6,
		host,
	}
}
