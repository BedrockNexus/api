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
  "latencyMs": 42
}
```

Private, loopback, link-local, reserved, and mixed public/private DNS targets are rejected.

A server counts as online if it answers either transport: a RakNet unconnected
ping over UDP, or NetherNet's `GET /v1/join` over HTTPS or HTTP on TCP. When it
answers both, NetherNet's values are reported. `latencyMs` is one round trip:
the RakNet ping when available, otherwise the TCP connect.

## Catalog API

Public catalog data and download redirects for launchers, bots and community
sites. No caller key is needed; accepted download requests update official Convex
counts. The full contract is served at `GET /v1/openapi.json`.

The API follows the site's sections. `/addons`, `/resource-packs` and `/plugins`
each have these endpoints:

| Endpoint | Returns |
|---|---|
| `GET /v1/{section}` | Search and browse |
| `GET /v1/{section}/{reference}` | One item |
| `GET /v1/{section}/{reference}/releases` | Public releases, newest first |
| `GET /v1/{section}/{reference}/releases/latest` | Newest public release |
| `GET /v1/{section}/{reference}/releases/{version}` | One release by version string |
| `GET /v1/{section}/{reference}/releases/{version}/download` | Fresh, uncached 307 redirect; accepts `latest` |

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
| `POST /v1/updates` | Newest release of up to 100 installed items |

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
- Download through a release's `downloadUrl`. It points at this API, while Convex applies
  availability and counting rules; the API redirects to the file. Never store the redirect target.
  `downloadUrl` is `null` when a plugin version has no published file.
- Verify downloads against `sha256`. It is `null` only for add-ons and resource
  packs released before checksums were recorded.
- Game versions have a `name`, which is what the site shows and `gameVersion`
  filters match, and a `version` holding just the Minecraft version.
- A server offline for 14 days is left out of `/v1/servers` and has `listed:
  false` on its own endpoint. It returns on its next successful check.
- Only published content is returned. Moderation details, audit fields, storage
  keys and account IDs are left out.

To check installed items for updates in one request, send each item's section,
`id` and installed version. Results come back in the same order.

```http
POST /v1/updates
Content-Type: application/json

{ "items": [{ "section": "plugins", "id": "p_j465gg", "version": "1.1.0" }] }
```

`updateAvailable` is true when the newest release's version differs from the one
sent. `found` is false for an item that no longer exists or is not public.

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
| `HUB_URL` | Base of catalog website links | `https://bedrocknexus.com` |
| `API_PUBLIC_URL` | Canonical origin of launcher download URLs | `https://api.bedrocknexus.com` |
| `DOWNLOAD_REDIRECT_SECRET` | Same server-only value as Hub and Convex; required for downloads | none |
| `CLIENT_IP_HEADER` | Optional trusted, proxy-overwritten client IP header | none |
| `TRUSTED_PROXY_HOPS` | Number of trusted rightmost forwarded addresses for downloads | `1` |
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
