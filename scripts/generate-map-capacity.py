"""Generate synthetic stress archives in a NEW directory; never touches exports.

Usage: python scripts/generate-map-capacity.py <new-directory>
Requires about 1 GiB free disk; validation needs an additional 512 MiB snapshot.
"""

import json
import os
from pathlib import Path
import sys
import time
import uuid
import zipfile

directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=False)
base = Path(__file__).parents[1] / 'tests/fixtures/maps/OfficialPackedSource.mcworld'
cases = [
    ('near-compressed-limit.mcworld', 511 * 1024**2, zipfile.ZIP_STORED),
    ('near-expanded-limit.mcworld', 4095 * 1024**2, zipfile.ZIP_DEFLATED),
]
for name, target, method in cases:
    started = time.perf_counter()
    with zipfile.ZipFile(base) as source, zipfile.ZipFile(directory / name, 'w', compression=method, compresslevel=1 if method else None, allowZip64=True) as output:
        used = 0
        for entry in source.infolist():
            data = source.read(entry.filename)
            used += len(data)
            output.writestr(entry.filename, data)
        block = os.urandom(100 * 1024) + bytes(924 * 1024)
        remaining = target - used
        with output.open('capacity-stress.bin', 'w', force_zip64=True) as payload:
            while remaining:
                chunk = block[:min(len(block), remaining)]
                payload.write(chunk)
                remaining -= len(chunk)
    print(json.dumps({'file': name, 'compressedBytes': (directory / name).stat().st_size, 'expandedBytes': target, 'generationSeconds': round(time.perf_counter() - started, 2)}), flush=True)
with (directory / 'over-compressed-limit.mcworld').open('wb') as output:
    output.truncate(512 * 1024**2 + 1)

# Probe maximum manifest count with large unused JSON values. This is accepted
# structure, not playable content, and exposes retained JSON heap pressure.
vanilla = base.with_name('SampleParkourWorld.mcworld')
with zipfile.ZipFile(vanilla) as source, zipfile.ZipFile(directory / 'max-metadata.mcworld', 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as output:
    for name in source.namelist():
        output.writestr(name, source.read(name))
    for index in range(64):
        manifest = {
            'format_version': 2,
            'header': {'name': 'Metadata stress', 'uuid': str(uuid.UUID(int=index * 2 + 1)), 'version': [1, 0, 0], 'min_engine_version': [1, 21, 0]},
            'modules': [{'type': 'data', 'uuid': str(uuid.UUID(int=index * 2 + 2)), 'version': [1, 0, 0]}],
            'unusedStressArray': [0] * 500000,
        }
        output.writestr(f'behavior_packs/pack{index}/manifest.json', json.dumps(manifest, separators=(',', ':')))
    output.writestr('ratio-padding.bin', os.urandom(1024 * 1024))
