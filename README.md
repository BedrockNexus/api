# BedrockNexus API

A small Bun and Hono service for public Minecraft Bedrock status checks, a
read-only public catalog, internal server ownership verification, and isolated
project artifact validation.

## Features

- Versioned read-only catalog for launchers, bots and community sites
- Bedrock status queries over RakNet UDP ping and NetherNet `GET /v1/join`
- DNS TXT and Bedrock MOTD ownership verification
- Private and reserved network blocking before outbound UDP and TCP traffic
- Bounded ports, timeouts, concurrency, request bodies, and request rates
- API-key protection for internal verification routes
- Conservative detection of default or explicitly branded Geyser responses
- Java status and SRV correlation for customized Geyser proxies
- Private validation of Bedrock add-ons and resource packs

## Setup

```bash
bun install
cp .env.example .env
bun run dev
bun run dev:worker
```

The API and Convex deployment must share the same secret:

- API: `API_SECRET_KEY`
- Convex: `BEDROCKNEXUS_API_KEY`

Convex may also set:

- `BEDROCKNEXUS_API_URL` for status checks
- `SERVER_VERIFICATION_API_URL` for ownership verification

## Commands

```bash
bun run lint
bun run typecheck
bun run test
bun run dev
bun run dev:worker
```

## Public Endpoint

### `GET /minecraft/status`

Query a public Bedrock server.

Query parameters:

- `ip` required: public server hostname or IP address
- `port` optional: `1-65535`, default `19132`
- `timeout` optional: `1000-8000` milliseconds, default `8000`

```json
{
  "online": true,
  "players": { "online": 10, "max": 100 },
  "motd": "Welcome to My Server",
  "version": "1.21.80",
  "gamemode": "Survival",
  "latencyMs": 42,
  "software": {
    "classification": "native_bedrock",
    "javaEndpoints": [],
    "reasons": ["No Java status endpoint was detected"]
  }
}
```

Private, loopback, link-local, reserved, and mixed public/private DNS targets are rejected.

A server counts as online if it answers either transport: a RakNet unconnected
ping over UDP, or NetherNet's `GET /v1/join` over HTTPS or HTTP on TCP. When it
answers both, NetherNet's values are reported. `latencyMs` is one round trip:
the RakNet ping when available, otherwise the TCP connect.

## Catalog API

Read-only public data from the Hub, for launchers, bots and community sites. No
key is needed. The full contract is served at `GET /v1/openapi.json`.

The API follows the site's sections. `/addons`, `/resource-packs` and `/plugins`
each have the same five endpoints:

| Endpoint | Returns |
|---|---|
| `GET /v1/{section}` | Search and browse |
| `GET /v1/{section}/{reference}` | One item |
| `GET /v1/{section}/{reference}/releases` | Public releases, newest first |
| `GET /v1/{section}/{reference}/releases/latest` | Newest public release |
| `GET /v1/{section}/{reference}/releases/{version}` | One release by version string |

The rest cover servers and the values you can filter by:

| Endpoint | Returns |
|---|---|
| `GET /v1/servers` | Search and browse servers |
| `GET /v1/servers/{reference}` | One server, with its latest status |
| `GET /v1/addon-categories` | Add-on categories |
| `GET /v1/resource-pack-categories` | Resource pack categories |
| `GET /v1/plugin-categories` | Plugin categories |
| `GET /v1/server-categories` | Server gamemodes |
| `GET /v1/server-software` | Software owners can declare |
| `GET /v1/game-versions` | Minecraft versions shown in pickers |

`{reference}` is a stable `id` or a current `slug`; servers also accept their
address. Store the `id`: slugs can be edited. An item only exists under its own
section, so a resource pack's ID under `/addons` answers `404`.

Lists take `limit` (1-48, default 24), `cursor`, `q` and `sort`, and filters such
as `category` can be repeated to match any of several values. Plugin endpoints
answer `404` while the plugin registry is switched off in the Hub's settings.

```json
{
  "data": [{ "id": "k17...", "slug": "my-addon", "name": "My Addon" }],
  "pagination": { "hasMore": true, "nextCursor": "..." }
}
```

- Keep requesting while `hasMore` is true. Filters run after the read, so a page
  can be short, or empty, while more results remain.
- Timestamps are ISO 8601 in UTC, and missing optional values are `null`.
- Errors look like `{ "error": { "code": "NOT_FOUND", "message": "..." } }`.
- Plugin lists filtered by `category`, or by more than one `software`, are not
  paginated and stop at `limit`.
- Download through a release's `downloadUrl`. It points at the Hub, which applies
  availability rules and redirects to the file. Never store the redirect target.
  `downloadUrl` is `null` when a plugin version has no published file.
- Verify `sha256` when it is present. Currently only plugin releases have one.
- Only published content is returned. Moderation details, audit fields, storage
  keys and account IDs are left out.

## Internal Endpoints

Internal endpoints require:

```http
X-API-Key: your-secret-key
```

Verification codes are issued and stored by the Hub's Convex backend, bound
to the requesting account, so a token copied from another server cannot be
replayed. This service only checks whether a code is present. The token placed
in DNS or the MOTD is:

```text
bedrocknexus-verify=A1B2C3D4
```

### `POST /server-verify/check`

DNS request:

```json
{
  "host": "play.example.com",
  "code": "A1B2C3D4",
  "method": "dns_txt",
  "port": 19132
}
```

MOTD request:

```json
{
  "host": "play.example.com",
  "port": 19132,
  "code": "A1B2C3D4",
  "method": "motd_token"
}
```

DNS verification requires an exact TXT value matching the token. MOTD verification checks both Bedrock MOTD lines on the exact host and port. Both methods also require the Bedrock server to be online and classified as native Bedrock.

```json
{ "verified": true }
```

### `POST /artifact-validate`

This endpoint is exposed only by the validator worker and requires the API
key. It accepts a short-lived R2 URL plus the expected project type, file name,
and file size. The response contains either a sanitized validation report or a
stable rejection code.

The worker rejects non-HTTPS and non-allowlisted download hosts, archive path
traversal, duplicate or encrypted entries, unsafe expansion ratios, malformed
pack manifests, and add-ons or resource packs without a matching module.

Addon uploads support unpacked pack directories and `.mcaddon` bundles
containing `.mcpack` files. Every bundled pack must have its own valid manifest
and supported module. A valid outer manifest does not bypass validation of
embedded packs. Resource-pack uploads still require their own resources module.

Validation permits one embedded pack layer, at most 64 embedded packs, and at
most 256 MB per embedded pack. Packs are processed sequentially through bounded
temporary files, which are removed after validation. The 10,000-entry, 4 GB
expanded-size and 200:1 expansion limits apply across the complete bundle;
each individual archive must also satisfy the expansion limit. Report counts
include embedded entries, and expanded-size totals include the container bytes
processed to inspect them. Manifest reads are capped at 1 MB and extracted
pack/manifest checksums are verified.

Temporary storage failures return HTTP 503 with `VALIDATOR_UNAVAILABLE` so
Convex retries validation instead of deleting an artifact as malformed.

## Deployment

Coolify builds and deploys the API from source with Railpack on pushes to
`main`. `Quality` runs lint, typecheck and tests on pull requests and `main`.

## Validator Deployment

Deploy the same image as a second service and override its command:

```bash
bun run start:worker
```

Set `PORT` to the service port, use the same `API_SECRET_KEY` as Convex, and set
`ARTIFACT_ALLOWED_HOSTS` to the exact hostname used by your R2 signed URLs, for
example:

```text
your-bucket-id.r2.cloudflarestorage.com
```

Do not expose the validator endpoint through the public status API service.

## Geyser Detection

[Geyser intentionally builds a normal Bedrock pong](https://github.com/GeyserMC/Geyser/blob/master/core/src/main/java/org/geysermc/geyser/network/netty/GeyserServer.java) and can replace or pass through both MOTD lines. The ping protocol exposes no mandatory Geyser software identifier.

The API combines several signals:

- Geyser default or explicit MOTD branding
- Java status responses on the same hostname and Bedrock port
- Java status responses on port `25565`
- `_minecraft._tcp` SRV targets
- MOTD similarity
- Synchronized player counts and matching capacity
- Java proxy signatures such as Velocity, BungeeCord, and Waterfall

The result is `native_bedrock`, `geyser_likely`, or `ambiguous`. Automatic ownership verification accepts only `native_bedrock`. This catches customized networks such as Complex Gaming without treating every hostname that offers Java Edition as definite Geyser.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | API listening port | `3001` |
| `API_SECRET_KEY` | Required production key for internal routes | none |
| `CORS_ORIGINS` | Comma-separated browser origins | `*` |
| `TRUST_PROXY_HEADERS` | Trust proxy-replaced client IP headers | `false` |
| `GENERAL_RATE_LIMIT` | General requests per minute per key | `60` |
| `STATUS_RATE_LIMIT` | Status requests per minute per key | `30` |
| `CATALOG_RATE_LIMIT` | Catalog requests per minute per key | `120` |
| `CONVEX_URL` | Hub Convex deployment read by the catalog; `/v1` answers `503` without it | none |
| `HUB_URL` | Base of catalog links and download URLs | `https://bedrocknexus.com` |
| `MAX_CONCURRENT_STATUS_CHECKS` | Simultaneous status checks per instance | `25` |
| `MAX_QUEUED_STATUS_CHECKS` | Status requests with the API key that may wait for a free slot; public requests are rejected instead | `1000` |
| `ARTIFACT_ALLOWED_HOSTS` | Exact comma-separated R2 hosts accepted by the validator worker | none |

Rate limits use an in-memory store per API instance. Use a shared store before horizontally scaling the API.

## Contributing And Security

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Report
security vulnerabilities privately by following [SECURITY.md](./SECURITY.md),
not through a public issue.

## License

BedrockNexus API is available under the [MIT License](./LICENSE).
