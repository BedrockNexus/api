# Local Maps capacity evidence

Measured 2026-10-28 on Windows 11 Pro (10.0.26300), Intel Core i7-1165G7
(4 cores, 8 logical processors), 15.6 GiB visible memory, Bun 1.3.6. Each
validation ran in a separate Bun process. These are local file-backed probes,
not hosted-worker, HTTP-transport, multiplayer or Minecraft acceptance.

| Synthetic stress case | Archive bytes | Expanded bytes | Validation time | Peak sampled RSS | Peak sampled snapshot |
| --- | ---: | ---: | ---: | ---: | ---: |
| Near compressed limit | 535,832,628 | 535,822,336 | 31,235 ms | 252.4 MiB | 511.0 MiB |
| Near expanded limit | 442,395,296 | 4,293,918,720 | 18,401 ms | 279.8 MiB | 421.9 MiB |
| Above compressed limit | 536,870,913 | Not read | 18 ms | 167.0 MiB | 0 bytes |
| Maximum manifest inventory | 1,402,457 | 65,128,862 | 2,103 ms | 659.7 MiB | 1.3 MiB |

The first two passed all structural checks. The third is an intentionally sparse,
oversized file and failed `INVALID_FILE_SIZE` before snapshot creation. These
cases do not establish that arbitrary data inside a structurally accepted archive
is playable: each accepted case adds an opaque synthetic stress payload to the
official-source fixture described in `tests/fixtures/maps/README.md`.

The expanded case uses a repeated 1 MiB block containing 100 KiB random bytes
and 924 KiB zero bytes, deflated at level 1. The compressed case stores its
payload without compression. Neither modifies creator exports. The source
archives remain outside the validator's temporary snapshot accounting.

The maximum-inventory case bundles 64 valid behavior manifests, each with an
unused array of 500,000 zero values below the individual 1 MiB JSON limit, plus
1 MiB random padding to stay within the expansion-ratio policy. It passes with
64 inactive-pack warnings and an 18,972-byte report. Its much higher RSS shows
that archive size alone does not bound JSON heap pressure: raw parsed manifest
objects are currently retained until inventory construction. A 512 MiB worker
is not qualified by these results. Reduce retention by normalizing manifests as
they are read, or establish a larger measured worker budget before rollout.

Run `bun src/measure-map.ts <world.mcworld>` from `api` in a fresh process
without concurrent Map evaluations. It samples RSS and newly owned local
snapshots every 25 ms and records process resource usage. Sampling is approximate;
RSS includes Bun startup, the ZIP library and validation. Source generation is
excluded from validation timing and memory. Temporary snapshots were removed.

Generate equivalent inputs with
`python scripts/generate-map-capacity.py <new-directory>`. Random payload bytes
can slightly change archive sizes on subsequent runs. The initial generator and
raw JSON measurements are retained locally under
`hub/test-results/maps-acceptance/` (ignored). These large synthetic inputs are
not repository fixtures and should not be uploaded as playable maps.

The 512 MiB compressed / 4 GiB expanded values remain evaluation limits.
Production sizing still requires measurements inside the actual worker/container,
including remote fetch time, available disk, CPU quota, memory limit, concurrency,
and the Hub's 120-second validator response timeout. A limit of one active Maps
validation per worker does not bound aggregate resource usage across replicas.
