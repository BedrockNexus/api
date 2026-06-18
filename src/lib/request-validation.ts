export class RequestValidationError extends Error {}

export function parsePort(value: string | undefined, fallback = 19_132) {
	const port = Number.parseInt(value ?? String(fallback), 10)
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new RequestValidationError('Port must be between 1 and 65535')
	}
	return port
}

export function parseTimeout(value: string | undefined, fallback = 8000) {
	const timeout = Number.parseInt(value ?? String(fallback), 10)
	if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 8000) {
		throw new RequestValidationError(
			'Timeout must be between 1000 and 8000 milliseconds',
		)
	}
	return timeout
}

export function parseVerificationCode(value: unknown) {
	if (typeof value !== 'string') {
		throw new RequestValidationError('Verification code is required')
	}

	const code = value.trim().toUpperCase()
	if (!/^[A-F0-9]{8}$/.test(code)) {
		throw new RequestValidationError('Verification code is invalid')
	}
	return code
}
