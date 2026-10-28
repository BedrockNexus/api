# Maps local evaluation, 2026-10-27

Local foundation only. The original artifact route still excludes Maps; a separate
Maps endpoint is implemented but disabled by default. Hub has local backend and
UI support; its UI and public Map creation switches are also disabled by default.
Mods remain paused. All work is local on `main`; nothing was pushed or deployed.

## Inputs and results

The unmodified Microsoft parkour sample is pinned with provenance and its MIT
notice under `tests/fixtures/maps/`. The user supplied two exports from
`C:\dev\worlds`; these remain external to the repositories. No source world was
modified. Validation uses a temporary file snapshot that is deleted afterward.

| Input | Compressed bytes | Expanded bytes | ZIP entries | Result |
| --- | ---: | ---: | ---: | --- |
| Microsoft `SampleParkourWorld.mcworld` | 53,915 | 63,390 | 8 | Structure checks pass |
| `Jean_-_Map_-_First_Export_2025-01-07@3-14-20_PM.mcworld` | 312,489,649 | 322,300,065 | 156 | Structure checks pass |
| `Jean_-_Increased_caves_2025-01-26@2-55-32_PM.mcworld` | 451,457,946 | 459,185,520 | 221 | Structure checks pass |

SHA-256 of the exact validated snapshots, in the same order:

```text
77d9f2cc2288fc4ba6fedae4ae16221bfe024fa3f35c8dac03129cae5720c9d9
8358309f5c3c7693f5bb83f5515b688271199948f33ba382c3c4553f0aaacc49
4261caea5465e9f584e12c5430748066023960d5b9690f1ea5962cd28bf9122b
```

All three use metadata header version 9, have saved command/command-block
settings enabled, and contain no bundled packs. The Microsoft sample contains
an experiment compound with no enabled entries; the two user exports do not
expose that compound. Missing values remain unknown rather than false.

The user exports took 15,743 ms and 20,010 ms respectively in one local run,
including snapshot copying, SHA-256, ZIP inspection and full-entry CRC checks.
These are individual observations under concurrent local work, not service
latency guarantees or benchmarks. Peak memory and disk headroom were not
measured. The snapshot's byte count equals the compressed file size; there is
no full-world extraction. Independent follow-up SHA-256 checks of both source
files matched their validated snapshot hashes.

## Limits and scope

The 256 MiB in-memory cap rejected both creator worlds before any parsing.
The file-backed runner therefore has a separate 512 MiB evaluation ceiling,
without buffering whole archives. This does not change pack limits or set a
production Maps cap. Other evaluation limits remain 4 GiB expanded, 10,000
entries, 200:1 expansion, 64 packs, 1 MiB metadata/JSON, and 64 KiB report.

The parser is a bounded little-endian file-NBT reader, with explicit version
selection, no format guessing and allowlisted output. Header 9 is fixture-backed;
other header versions return unsupported-format. NBT limits include depth 32,
50,000 tags, 16,384 collection elements and 32,768 bytes per string.

Bundled manifest-format-2 behavior/resource/script packs, UUID dependencies and
world activation lists are covered by generated fixtures. Those tests also
cover missing script entry points, duplicate identities, unsafe paths and
links, nested/encrypted archives, expansion limits, bad metadata, input mutation
and corrupted CRCs. No scripts execute. A test verifies that HTTP still rejects
Maps. Hub tests check strict release fields, game-version catalog membership,
pack declarations and reconciliation against observations.

These checks do not open LevelDB or establish database integrity, a successful
Minecraft import, compatibility, or playability. There is no hosted upload,
moderation, promotion, download or deletion acceptance for Maps yet.

## Next acceptance work

- Obtain current exports with behavior/resource/script packs and known enabled
  experiments. Real packed-world coverage is still missing.
- Confirm supported save/manifest versions with those exports; measure worker
  memory, disk, concurrency and processing limits before selecting production
  upload limits or changing validator timeouts.
- Complete hosted acceptance of the local sealed-object, size/hash/identity,
  snapshot/report and strict-eligibility integration before enabling publishing.
- Exercise the gated Maps creator, moderator and public interfaces through the
  signed-in hosted lifecycle; isolated component checks do not establish it.
- Run the full personal/organization lifecycle in development and clean-client
  Minecraft import/play tests. Deployment requires separate user authorization.

## Local verification

- API lint/type checking and 96 Bun tests passed, including 44 Maps tests.
- Hub application/Convex type checks and changed-file lint passed. All 102 Bun
  tests passed, including 15 metadata tests; all 199 Vitest tests passed with
  `bun x vitest run --maxWorkers=1`.
- The initial parallel Vitest run hit first-test timeouts and was stopped.
  The single-worker rerun completed without changing test timeouts or source
  configuration. No browser/build/deployment or in-game verification was run
  for this dormant validation slice.

The subsequent local backend slice adds ten API transport checks and eleven
Convex integration cases. It tests sealed identity requests, conditional copies,
bounded report parsing, metadata/catalog checks, reservation reuse, personal and
organization permissions, stale/deleted callbacks, and late promotion after
unpublish. HTTP/storage operations in these integration tests are mocked; no
hosted resources were modified. See Hub `docs/MAPS_PUBLISHING_CONTRACT.md` for
the current integration boundary.

Final backend-slice checks passed: API lint/type checking and 106 tests; Hub
application/Convex type checks, changed application-file lint, 109 Bun tests and
210 Vitest tests (`--maxWorkers=1`). The updated Maps creation test also covers
active numeric catalog versions with two, three and four components. No Convex
push/code deployment, browser flow or hosted R2 operation was performed.

## UI slice update (2026-10-28)

Hub now includes default-off Maps routes/forms/navigation and requirement
displays for creators, moderators and public releases. The final production
build, application/Convex types, changed-file lint, 112 Bun tests, 214 Vitest
tests and a standalone headless component interaction check passed. The
component fixture uses synthetic data and no backend/storage/auth services.
The original creator world files were not changed or copied into the repos.
No environment switch, deployment, push, hosted lifecycle or Minecraft import
was performed. Hub `docs/MAPS_PUBLISHING_CONTRACT.md` records the current gates.

## Archive review follow-up (2026-10-28)

- Enforce the shared 64-pack limit while enumerating archive entries, before
  inflating contents or retaining manifest JSON. Previously the limit was checked
  after reading all metadata, allowing an oversized inventory to consume memory
  before rejection. Mixed behavior/resource inventories share the same limit.
- Reject case and Unicode normalization aliases of reserved pack roots,
  activation lists and manifest filenames. These could otherwise be skipped by
  the exact-name inventory while remaining ambiguous across client platforms.
  Creator-chosen casing within pack folder names remains supported.
- Added 13 regression cases, including malformed JSON and corrupt database data
  in oversized inventories to prove rejection occurs before content reads.
  API lint, type checking and all 119 tests pass, including the unchanged pinned
  Microsoft world. No new real-world export or Minecraft acceptance was run.

This follow-up changes only local API validation and documentation. Hub runtime
code, the three default-off switches and hosted resources were not changed.
Real packed exports, hosted capacity/lifecycle and clean-client import/play
acceptance remain open. Mods remain paused; nothing was pushed or deployed.

## Development acceptance update (2026-10-28)

The user subsequently authorized development testing. A pinned official-source
world with released behavior/resource/script packs now has provenance, a rebuild
script and regression coverage. API lint/types and all 120 tests pass. This is a
source-built fixture; no game-exported packed world is available.

See `MAPS_CAPACITY.md` for local limits probes, including the maximum-manifest
case's 659.7 MiB RSS. Actual worker/container sizing and JSON retention remain
production gates. Development Convex, real R2/CDN delivery and the temporary
authenticated API worker passed the publishing lifecycle; signed-in Hub browser
acceptance also passed after fixing shared upload-metadata readiness. The Hub
record is `docs/DEV_MAPS_ACCEPTANCE.md`.

Development configuration was restored and temporary resources were cleaned.
No Git push or production deployment occurred; Mods remain paused. Clean-client
Minecraft import/play and a game-exported packed-world check remain open.
