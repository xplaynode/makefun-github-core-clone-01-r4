[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xplaynode/makefun-github-core-clone-01-r4/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xplaynode/makefun-github-core-clone-01-r4/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Lucky Forge

A small, fast, dependency-free GitHub-core forge that runs as a single Node.js
service. It keeps every object in memory and serves four surfaces from one
store:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with shallow/deepen)
  and v0 advertisements, `git-upload-pack` and `git-receive-pack` with
  report-status over side-band-64k. Packfiles are built in-process (SHA-1,
  zlib) with no deltas, and repeated fetches of the same tip reuse a cached
  pack instead of rebuilding it.
- **REST v3** — repositories, contents, branches, commits, labels, issues,
  comments and pull requests (including squash merges with three-way,
  per-file conflict detection).
- **GraphQL v4** — viewer/repository/issue/pull-request reads, cursor
  pagination, the create/close/merge/comment mutations, Relay global ids,
  `node(id:)` and the `__type` introspection probes.
- **MCP** — a Streamable-HTTP JSON-RPC endpoint with `server/discover`,
  `tools/list` and `tools/call` for repository, issue and pull-request tools
  that operate on the same store as the REST surface.

## Running

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: it binds an ephemeral port, registers it
with the env named by `MAKEFUN_ENV_URL`, and serves until the env reports the
trial is done. `app.ts` builds the HTTP server; the surface implementations
live in `rest.ts`, `smart.ts`, `graphql.ts` and `mcp.ts` over the shared
store in `core.ts`.

## Design notes

- One store, four views: an issue created over MCP is the same object the
  REST surface lists, with the same id, because all surfaces read and write
  the same records.
- Hot paths avoid re-work: serialized issue bodies, ref advertisements and
  clone packs are cached against a per-repository version counter and
  invalidated on mutation.
- Deterministic by construction: seeded identities, synthetic timestamps and
  counter-based request ids — two runs over the same request sequence produce
  byte-identical answers.
