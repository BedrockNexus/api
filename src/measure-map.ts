import { readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { validateMapFile } from './lib/map-validator'

// Run each sample in its own Bun process, without concurrent Map evaluations.
// This measures local file-backed validation, not remote transport or gameplay.
const path = process.argv[2]
if (!path) throw new Error('Usage: bun src/measure-map.ts <world.mcworld>')
const before = new Set(readdirSync(tmpdir()))
let peakRss = process.memoryUsage().rss
let peakSnapshotBytes = 0
const initialRss = peakRss
const started = performance.now()
const sample = () => {
	peakRss = Math.max(peakRss, process.memoryUsage().rss)
	for (const name of readdirSync(tmpdir())) {
		if (!name.startsWith('bedrocknexus-world-') || before.has(name)) continue
		try {
			peakSnapshotBytes = Math.max(
				peakSnapshotBytes,
				statSync(join(tmpdir(), name, 'world.mcworld')).size,
			)
		} catch {}
	}
}
const timer = setInterval(sample, 25)
try {
	const result = await validateMapFile(path)
	sample()
	console.log(
		JSON.stringify({
			file: basename(path),
			elapsedMs: Math.round(performance.now() - started),
			initialRss,
			peakRss,
			peakSnapshotBytes,
			resourceUsage: process.resourceUsage(),
			...result,
		}),
	)
} finally {
	clearInterval(timer)
}
