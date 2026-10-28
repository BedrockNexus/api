import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertAllowedArtifactUrl } from './artifact-validator'
import {
	MAP_EVALUATION_POLICY,
	type MapEvaluationResult,
	validateOwnedMapSnapshot,
} from './map-validator'

export interface RemoteMapRequest {
	fileName: string
	fileSize: number
	downloadUrl: string
	sourceEtag: string
}
export type RemoteMapResult = MapEvaluationResult extends infer R
	? R extends { valid: true; report: infer P }
		? { valid: true; report: P & { sourceEtag: string } }
		: R
	: never

/** The source must be the Hub's sealed object, never a still-writable PUT key. */
export async function validateRemoteMap(
	request: RemoteMapRequest,
	allowedHosts: readonly string[],
): Promise<RemoteMapResult> {
	const invalid = (code: string, error: string): RemoteMapResult => ({
		valid: false,
		code,
		error,
	})
	try {
		assertAllowedArtifactUrl(request.downloadUrl, allowedHosts)
	} catch {
		return invalid(
			'UNTRUSTED_URL',
			'Use an allowlisted private HTTPS artifact URL.',
		)
	}
	if (!request.fileName.toLowerCase().endsWith('.mcworld'))
		return invalid('INVALID_EXTENSION', 'Maps require one .mcworld file.')
	if (
		!Number.isSafeInteger(request.fileSize) ||
		request.fileSize <= 0 ||
		request.fileSize > MAP_EVALUATION_POLICY.fileBackedCompressedBytes
	)
		return invalid(
			'INVALID_FILE_SIZE',
			'The world exceeds local Maps evaluation limits.',
		)
	if (!/^"[a-f0-9]{32}(?:-\d+)?"$/i.test(request.sourceEtag))
		return invalid(
			'ARTIFACT_IDENTITY_MISMATCH',
			'A strong sealed-object ETag is required.',
		)
	let directory: string | undefined
	try {
		const response = await fetch(request.downloadUrl, {
			headers: {
				'If-Match': request.sourceEtag,
				'Accept-Encoding': 'identity',
			},
			redirect: 'error',
			credentials: 'omit',
			signal: AbortSignal.timeout(100_000),
		})
		if (
			response.status === 412 ||
			(response.ok && response.headers.get('etag') !== request.sourceEtag)
		) {
			await response.body?.cancel()
			return invalid(
				'ARTIFACT_IDENTITY_MISMATCH',
				'The sealed artifact changed; upload and validate a new release.',
			)
		}
		if (response.status !== 200 || !response.body) {
			await response.body?.cancel()
			return invalid(
				'VALIDATOR_UNAVAILABLE',
				'The private artifact could not be fetched.',
			)
		}
		const declaredLength = response.headers.get('content-length')
		if (
			(declaredLength !== null &&
				Number(declaredLength) !== request.fileSize) ||
			(response.headers.get('content-encoding') ?? 'identity') !== 'identity'
		) {
			await response.body.cancel()
			return invalid(
				'INVALID_FILE_SIZE',
				'Stored artifact size or encoding differs from the reserved upload.',
			)
		}
		directory = await mkdtemp(join(tmpdir(), 'bedrocknexus-remote-world-'))
		const path = join(directory, 'world.mcworld')
		const target = await open(path, 'wx')
		const hash = createHash('sha256')
		let size = 0
		const reader = response.body.getReader()
		try {
			while (true) {
				const next = await reader.read()
				if (next.done) break
				const chunk = next.value
				size += chunk.length
				if (size > request.fileSize) {
					await reader.cancel()
					return invalid(
						'INVALID_FILE_SIZE',
						'The fetched artifact exceeds its reserved size.',
					)
				}
				hash.update(chunk)
				let offset = 0
				while (offset < chunk.length) {
					const written = await target.write(
						chunk,
						offset,
						chunk.length - offset,
					)
					if (!written.bytesWritten)
						throw new Error('Snapshot storage unavailable')
					offset += written.bytesWritten
				}
			}
		} finally {
			await reader.cancel().catch(() => undefined)
			await target.close()
		}
		if (size !== request.fileSize)
			return invalid('INVALID_FILE_SIZE', 'The fetched artifact was truncated.')
		const result = await validateOwnedMapSnapshot(
			path,
			size,
			hash.digest('hex'),
		)
		return result.valid
			? {
					valid: true,
					report: { ...result.report, sourceEtag: request.sourceEtag },
				}
			: result
	} catch {
		return invalid(
			'VALIDATOR_UNAVAILABLE',
			'The artifact could not be fetched or temporary storage is unavailable.',
		)
	} finally {
		if (directory) {
			await rm(join(directory, 'world.mcworld'), { force: true })
			await rmdir(directory)
		}
	}
}
