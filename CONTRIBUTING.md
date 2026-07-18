# Contributing To BedrockNexus API

Thanks for helping improve the BedrockNexus API. Contributions should remain
focused, preserve the public and internal endpoint contracts, and include
enough context to review safely.

## Before You Start

1. Search existing issues and pull requests for related work.
2. Open an issue before beginning a large protocol, storage-validation, or API
   contract change.
3. Never include credentials, production data, private vulnerability reports,
   signed storage URLs, or user data in an issue, commit, fixture, or log.

## Development

This repository uses Bun. Do not introduce npm, pnpm, or Yarn lockfiles.

```bash
bun install
cp .env.example .env
bun run dev
```

Use your own development credentials and public test servers. Internal routes
require `API_SECRET_KEY`; never use a production secret locally or in tests.

Keep network targets validated before outbound DNS, UDP, or HTTP access. New
internal endpoints must fail closed when authentication is not configured.
Artifact validation must remain bounded and must not extract untrusted archives
to disk.

## Before Opening A Pull Request

Run:

```bash
bun run lint
bun run typecheck
bun test
```

Pull requests should explain the problem, the selected solution, endpoint or
environment changes, and verification performed. Add or update tests whenever
behavior changes.

## Licensing

By submitting a contribution, you agree that it may be distributed under this
repository's MIT License.
