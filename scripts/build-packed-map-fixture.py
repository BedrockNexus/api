"""Build an official-source Map fixture; this is not a game-exported world.

Usage: python scripts/build-packed-map-fixture.py <new-output.mcworld>
The committed fixture has a pinned archive hash. Rebuilding preserves source
payloads, but ZIP timestamps may produce a different archive hash.
"""

import hashlib
import io
import json
from pathlib import Path
import sys
from urllib.request import urlopen
import zipfile

SOURCE_URL = (
    'https://github.com/microsoft/minecraft-samples/releases/download/'
    'v0.1.3-alpha/chill_dreams_complete_v0.1.3.mcaddon'
)
SOURCE_SHA256 = '8ac62026510f7b6f696993c158ea9b654c40f1444ba7b88a65dd1b0ed2d0a2d8'
WORLD_SHA256 = '77d9f2cc2288fc4ba6fedae4ae16221bfe024fa3f35c8dac03129cae5720c9d9'


def main():
    output = Path(sys.argv[1])
    world_bytes = (Path(__file__).parents[1] / 'tests/fixtures/maps/SampleParkourWorld.mcworld').read_bytes()
    assert hashlib.sha256(world_bytes).hexdigest() == WORLD_SHA256
    with urlopen(SOURCE_URL, timeout=60) as response:
        source_bytes = response.read(1024 * 1024)
    assert hashlib.sha256(source_bytes).hexdigest() == SOURCE_SHA256
    with zipfile.ZipFile(io.BytesIO(world_bytes)) as world, zipfile.ZipFile(io.BytesIO(source_bytes)) as addon, zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as result:
        for filename in world.namelist():
            result.writestr(filename, world.read(filename))
        for container in addon.namelist():
            if not container.endswith('.mcpack'):
                continue
            with zipfile.ZipFile(io.BytesIO(addon.read(container))) as pack:
                manifest = json.loads(pack.read('manifest.json'))
                kind = 'resource' if manifest['modules'][0]['type'] == 'resources' else 'behavior'
                for filename in pack.namelist():
                    if not filename.endswith('/'):
                        result.writestr(f'{kind}_packs/{container[:-7]}/{filename}', pack.read(filename))
                result.writestr(f'world_{kind}_packs.json', json.dumps([{
                    'pack_id': manifest['header']['uuid'],
                    'version': manifest['header']['version'],
                }]))
    print(hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
