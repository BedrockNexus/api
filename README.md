# BedrockNexus API

A small Bun and Hono service for public Minecraft Bedrock status checks and internal server ownership verification.

## Features

- Bedrock status queries over native RakNet UDP ping
- DNS TXT and Bedrock MOTD ownership verification
- Private and reserved network blocking before outbound UDP traffic
- Bounded ports, timeouts, concurrency, request bodies, and request rates
- API-key protection for internal verification routes
- Conservative detection of default or explicitly branded Geyser responses
- Java status and SRV correlation for customized Geyser proxies

## Setup

```bash
bun install
cp .env.example .env
bun run dev
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
```

## Public Endpoint

### `GET /minecraft/status`

Query a public Bedrock server.

Query parameters:

- `ip` required: public server hostname or IP address
- `port` optional: `1-65535`, default `19132`
- `timeout` optional: `1000-8000` milliseconds, default `5000`

```json
{
  "online": true,
  "players": { "online": 10, "max": 100 },
  "motd": "Welcome to My Server",
  "version": "1.21.80",
  "gamemode": "Survival",
  "software": {
    "classification": "native_bedrock",
    "javaEndpoints": [],
    "reasons": ["No Java status endpoint was detected"]
  }
}
```

Private, loopback, link-local, reserved, and mixed public/private DNS targets are rejected.

## Internal Endpoints

Internal endpoints require:

```http
X-API-Key: your-secret-key
```

### `POST /server-verify/code`

Generate an ownership verification code.

```json
{ "code": "A1B2C3D4" }
```

The token placed in DNS or the MOTD is:

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
| `MAX_CONCURRENT_STATUS_CHECKS` | Simultaneous UDP checks per instance | `25` |

Rate limits use an in-memory store per API instance. Use a shared store before horizontally scaling the API.
