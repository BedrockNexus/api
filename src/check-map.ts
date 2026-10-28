import { basename } from 'node:path'
import { validateMapFile } from './lib/map-validator'

// Local evaluation only. Uses temporary snapshots; never modifies source worlds.
if (import.meta.main) {
	const paths = process.argv.slice(2)
	if (!paths.length) {
		console.error('Usage: bun run src/check-map.ts <world.mcworld> [...]')
		process.exitCode = 1
	}
	for (const path of paths) {
		const started = performance.now()
		try {
			const result = await validateMapFile(path)
			console.log(
				JSON.stringify(
					{
						fileName: basename(path),
						elapsedMs: Math.round(performance.now() - started),
						...result,
					},
					null,
					2,
				),
			)
			if (!result.valid) process.exitCode = 1
		} catch {
			console.error(
				JSON.stringify({
					fileName: basename(path),
					valid: false,
					code: 'LOCAL_FILE_UNAVAILABLE',
					error: 'Cannot read the local world within evaluation limits.',
				}),
			)
			process.exitCode = 1
		}
	}
}
