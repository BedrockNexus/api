import { describe, expect, test } from 'bun:test'
import { motdHasVerificationToken } from '../src/routes/server-verify'

describe('motdHasVerificationToken', () => {
	test('accepts the hyphen form used in server.properties', () => {
		expect(
			motdHasVerificationToken(
				['My Server bedrocknexus-verify-0A1B2C3D'],
				'0A1B2C3D',
			),
		).toBe(true)
	})

	test('still accepts the = form', () => {
		expect(
			motdHasVerificationToken(
				[undefined, 'bedrocknexus-verify=0a1b2c3d'],
				'0A1B2C3D',
			),
		).toBe(true)
	})

	test('rejects the token cut off at the =, as BDS stores it', () => {
		expect(
			motdHasVerificationToken(
				['\\"bedrocknexus-verify', 'Abyss Fishing Main'],
				'0A1B2C3D',
			),
		).toBe(false)
	})

	test('rejects another code', () => {
		expect(
			motdHasVerificationToken(['bedrocknexus-verify-FFFFFFFF'], '0A1B2C3D'),
		).toBe(false)
	})
})
