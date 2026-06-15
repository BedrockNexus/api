import { describe, expect, test } from 'bun:test'
import {
	isPublicIpAddress,
	PublicTargetError,
	resolvePublicTarget,
} from '../src/lib/public-target'

describe('public target validation', () => {
	test('recognizes public IP addresses', () => {
		expect(isPublicIpAddress('1.1.1.1')).toBe(true)
		expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true)
	})

	test('blocks private, loopback, link-local, and unspecified ranges', () => {
		expect(isPublicIpAddress('127.0.0.1')).toBe(false)
		expect(isPublicIpAddress('10.0.0.1')).toBe(false)
		expect(isPublicIpAddress('169.254.1.1')).toBe(false)
		expect(isPublicIpAddress('0.0.0.0')).toBe(false)
		expect(isPublicIpAddress('::1')).toBe(false)
		expect(isPublicIpAddress('fc00::1')).toBe(false)
	})

	test('rejects private literal targets', async () => {
		expect(resolvePublicTarget('127.0.0.1')).rejects.toBeInstanceOf(
			PublicTargetError,
		)
	})

	test('accepts public literal targets without DNS', async () => {
		expect(await resolvePublicTarget('1.1.1.1')).toEqual({
			address: '1.1.1.1',
			family: 4,
			host: '1.1.1.1',
		})
	})

	test('rejects URL-shaped host input', async () => {
		expect(resolvePublicTarget('https://example.com')).rejects.toBeInstanceOf(
			PublicTargetError,
		)
	})
})
