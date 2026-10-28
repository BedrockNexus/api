# Maps validation fixtures

`SampleParkourWorld.mcworld` is an unmodified Microsoft sample:

- Source: https://github.com/microsoft/minecraft-samples/blob/5e04b6f719c316b0611f569af0cab7d6e9a2fb26/parkour_sample_world/SampleParkourWorld.mcworld
- Commit: `5e04b6f719c316b0611f569af0cab7d6e9a2fb26`
- SHA-256: `77d9f2cc2288fc4ba6fedae4ae16221bfe024fa3f35c8dac03129cae5720c9d9`
- Size: 53,915 bytes. Downloaded 2026-10-27.
- License: MIT, Microsoft Corporation; see `LICENSE.microsoft.txt`.

This is an official sample artifact, not evidence of a current clean-client
import/play test or representative large-world capacity. Its `level.dat` file
uses storage header version 9. Generated fixtures in `map-validator.test.ts`
exercise malformed archives and pack references separately.

`OfficialPackedSource.mcworld` is a derived, source-built integration fixture:

- Base: the unchanged file payloads from `SampleParkourWorld.mcworld` above.
- Bundled packs: Microsoft's [Chill Dreams v0.1.3-alpha release](https://github.com/microsoft/minecraft-samples/releases/tag/v0.1.3-alpha),
  `chill_dreams_complete_v0.1.3.mcaddon`, unpacked into the world's behavior/resource
  pack folders. Pack file payloads, UUIDs, versions and scripts are unchanged.
- Source container SHA-256:
  `8ac62026510f7b6f696993c158ea9b654c40f1444ba7b88a65dd1b0ed2d0a2d8`.
- Added the two activation JSON files using the pack header identities.
- Fixture SHA-256:
  `4967b466a0db7862107aa520db5ccce9bc4596ea6ea9fe327500611bf64ed406`.
- Size: 577,562 bytes; 60 entries; 629,808 expanded bytes. Created 2026-10-28.
- License: Microsoft MIT; see `LICENSE.microsoft.txt`.
- Rebuild: `python scripts/build-packed-map-fixture.py <new-output.mcworld>`.
  The builder verifies both input hashes and refuses to overwrite its output.
  ZIP timestamps can change the resulting archive hash when rebuilt.

This tests real released behavior/resource/script payloads, their mutual pack
dependencies, activation and byte/hash reporting. It is not a game-exported
packed world, nor evidence of Minecraft compatibility, import or play. No pack
script is executed by validation. The user's available exports contain no packs;
acceptance of a game-exported packed world remains open.
