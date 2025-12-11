# BedrockNexus API

A lightweight Hono API service for BedrockNexus, handling Minecraft Bedrock server queries and verification.

## Features

- **Server Status**: Query Minecraft Bedrock server status (online/offline, player count, MOTD)
- **DNS Verification**: Verify server ownership via DNS TXT records
- **Code Generation**: Generate verification codes for server ownership

## Tech Stack

- [Hono](https://hono.dev/) - Fast, lightweight web framework
- [Bun](https://bun.sh/) - Fast JavaScript runtime
- [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol) - Minecraft Bedrock protocol implementation

## Setup

```bash
# Install dependencies
bun install

# Copy environment file
cp .env.example .env

# Start development server
bun run dev
```

## API Endpoints

### `GET /api/minecraft/status`
Query a Bedrock server's status.

**Query Parameters:**
- `ip` (required): Server IP address or hostname
- `port` (optional): Server port (default: 19132)
- `timeout` (optional): Query timeout in ms (default: 5000)

**Response:**
```json
{
  "online": true,
  "players": { "online": 10, "max": 100 },
  "motd": "Welcome to My Server",
  "version": "1.20.0",
  "gamemode": "Survival"
}
```

### `GET /api/minecraft/verify`
Verify server ownership via DNS TXT record.

**Query Parameters:**
- `ip` (required): Server domain
- `code` (required): Verification code

**Response:**
```json
{ "verified": true }
```

### `GET /api/minecraft/generate-code`
Generate a verification code.

**Response:**
```json
{ "code": "A1B2C3D4" }
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `3001` |
| `PAYLOAD_API_URL` | Payload CMS URL | `http://localhost:3000` |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | `http://localhost:3000` |
