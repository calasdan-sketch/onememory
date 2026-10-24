# Contributing to OneMemory

Thanks for your interest — small, focused contributions are very welcome.

## Ground rules

- **Keep it minimal.** This project deliberately has two runtime dependencies
  (`@modelcontextprotocol/sdk`, `zod`) and no native modules. A PR that adds a
  dependency needs a strong reason; one that adds a native module almost
  certainly won't be merged.
- **Tests pass.** `npm test` must be green (it builds, then runs the suite).
  New behaviour needs a test; bug fixes should come with a regression test.
- **No secrets, ever.** Don't commit tokens, `.env` files, or anything under
  `data/`.

## Getting set up

Requires Node.js **>= 24** (for the built-in `node:sqlite`).

```bash
npm install
npm run build
npm test
node dist/src/cli.js doctor   # sanity-check Node/DB/token
```

## Before you open a PR

1. `npm test` is green locally.
2. `npm audit` shows no new high/critical issues.
3. Your change keeps the public HTTP/MCP surface backwards-compatible, or the
   PR explains why a break is necessary.
4. If it touches security (auth, tokens, scopes, the request path), say so in
   the PR description so it gets a closer look.

## Reporting bugs / ideas

Open an issue using the templates. For anything security-sensitive, **don't**
open a public issue — see [SECURITY.md](./SECURITY.md).
