import { describe, expect, test } from 'bun:test'
import {
	parsePort,
	parseTimeout,
	parseVerificationCode,
	RequestValidationError,
} from '../src/lib/request-validation'

describe('request validation', () => {
	test('parses bounded ports and timeouts', () => {
		expect(parsePort('19132')).toBe(19_132)
		expect(parseTimeout('5000')).toBe(5000)
	})

	test('rejects invalid ports and timeouts', () => {
		expect(() => parsePort('0')).toThrow(RequestValidationError)
		expect(() => parsePort('65536')).toThrow(RequestValidationError)
		expect(() => parseTimeout('999')).toThrow(RequestValidationError)
		expect(() => parseTimeout('8001')).toThrow(RequestValidationError)
	})

	test('normalizes valid verification codes', () => {
		expect(parseVerificationCode('a1b2c3d4')).toBe('A1B2C3D4')
	})

	test('rejects malformed verification codes', () => {
		expect(() => parseVerificationCode('not-valid')).toThrow(
			RequestValidationError,
		)
	})
})
