# Upgrading from 1.3.x

This page is for an existing 1.3.x install moving to 1.4.x (1.4.2 is the current one). Nothing here is
needed for a fresh install.

**EXPERIMENTAL in 1.4.x:** signed attestations, cross-server writer ids, `trust rotate`,
`trust attester-revoke` and the `--any-server` flag. They may change in a minor release. The local
distrust list and writer labels are the stable part. See [trust.md](./trust.md).

## What happens when you start 1.4.x

1. **The schema upgrade is one-way.** The first start on a database at schema v1 to v13 migrates it to v14
   (new columns, three small tables, an index over note writers). No note text is touched. An older
   version cannot open a v14 database.
2. **A backup is made first.** Before migrating, OneMemory writes a verified copy to
   `<database>.pre-v14-backup` (it is built as `.partial`, checked for the same number of notes, the old
   schema version and an integrity check, then renamed). If a valid copy from an earlier attempt exists it
   is kept under a dated name and a fresh one is made. The upgrade refuses to start when the disk has no
   room for the copy: **free about the size of the database plus its WAL**.
3. **Expect a delay on the first start** of a large database: building the index takes a few seconds per
   hundred thousand notes. In Docker or a service manager, give the health check a start period
   (the image uses `--start-period=60s`; use a longer one for a very large database) so the container is not killed
   mid-migration.
4. **The data directory must be writable** (the migration, the backup copy and the signing key all write
   there). On a read-only mount OneMemory now stops with a readable message naming the directory.

Run `onememory doctor` afterwards: it lists the pre-migration copies with size and age, and warns about
leftover `.partial` files.

## Rolling back

To roll back:

Stop every OneMemory process (server, MCP clients, runners, the CLI). **Move** `<database>.pre-v14-backup`
over the database (a copy would leave the original; remove the `-wal` and `-shm` files next to it),
reinstall 1.3.x and start it. Anything written after the upgrade is not in the backup. Once you are happy
with 1.4.x, `onememory backup --prune-premigration` deletes the copies (they are plaintext even if you
later enable at-rest encryption). Stale `-journal` sidecars and old partial copies are swept
automatically.

## What behaves differently

- **Old notes have no writer.** Rows from before schema v13 have `written_by` of `""`. A distrust rule
  affects what is written from now on; it cannot say who wrote the older notes.
- **Runners older than 1.3.4** write a heartbeat with no writer marker, which 1.4.x no longer believes.
  Update the runner ([RUNNER.md](https://github.com/calasdan-sketch/onememory/blob/main/docs/RUNNER.md)), or set `ONEMEMORY_RUNNER_ACCEPT_LEGACY=1` as a stopgap.
- **The default export keeps its shape**: `{"notes": [...]}` with no header and no signatures. The notes in
  it carry extra fields (`merged_from_writers`, `written_by`, ...). `?attest=1` / `--attest` adds the
  signed envelope; `import` accepts the plain object, the envelope and a bare array.
- **Import streams.** `onememory import --file` reads the file in batches instead of loading it whole.
  For a file with several batches the similarity edges are not rebuilt per batch: run
  `onememory rebuild-edges` afterwards (the command prints that hint).
- **Notes imported without a verified attestation** are marked `imported_unverified: true` and the agent
  banner says so. The default still accepts them. To refuse them, use `--require-attestation`,
  `require_attestation` over the API, or `ONEMEMORY_IMPORT_REQUIRE_ATTESTATION=1`.
- **`include_distrusted`** is admin-only, and for a namespace-pinned admin with read grants it applies to
  that token's own namespace only. The primary `ONEMEMORY_TOKEN` is always an admin.
- **New variables** (all optional, documented in [configuration.md](./configuration.md)):
  `ONEMEMORY_ATTEST_MIN_VERSION`, `ONEMEMORY_IMPORT_REQUIRE_ATTESTATION`, `ONEMEMORY_TRUSTED_ATTESTERS`,
  `ONEMEMORY_ATTEST_KEY_FILE`.

## A short checklist

1. `onememory backup --out <dir>` yourself as well; the automatic copy is only the pre-upgrade state.
2. Check free disk space (database size, plus the same again for the copy).
3. Upgrade, start, wait for the migration, run `onememory doctor`.
4. If you use several servers: read [trust.md](./trust.md), decide whether you want attestations at all
   (they are EXPERIMENTAL), and back up the signing key (`trust export-key --out <file>`,
   `backup --include-attest-key`).
5. Update runners older than 1.3.4.
