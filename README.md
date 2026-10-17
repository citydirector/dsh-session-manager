# dsh-session-manager

[English](README.md) · [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/tag/citydirector/dsh-session-manager?sort=semver&label=release)](https://github.com/citydirector/dsh-session-manager/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![DSH tool](https://img.shields.io/badge/DSH%20tool-%E2%89%A50.1.2-blue)](https://github.com/topics/dsh-plugin)

A **standalone session manager** for DeepSeek Harness (DSH): an offline command-line tool, not a plugin, with no dependencies. Works with the portable, desktop, standard install (`~/.dsh`) and npm versions of DSH.

| Feature | What it does |
|---|---|
| List sessions | Lists sessions across every workspace: title, last used, directory, size, and archived / pinned / sub-agent / old generation / hidden-by-DSH flags |
| Upgrade old sessions | Brings v0 / v2 / v3 sessions up to the current generation (v4) with **DSH's own migrator**, leaving the old files as they were |
| Clean up empty sessions | Finds sessions that were created but never got a message, and moves them to the trash |
| Archive / unarchive | Uses DSH's own archive set (`archivedSessionIds`), leaving logs and workspace slots alone; archived sessions can be listed on their own and deleted selectively or all at once |
| Trash | Move in, restore (back to the original workspace slot, with archive / pin flags), purge |
| Clean loops | Cuts `Go. Emit. Let me write.`-style loops already committed to the history (the same detection rules as [dsh-loop-rescue](https://github.com/citydirector/dsh-loop-rescue)) |
| Repair broken tails | Trims trailing turns that are only errors and retries, and compacts offline when the context is still too large, so a session that overflows on every retry can carry on |
| Repair hidden sessions | DSH silently hides a session whose compressed frame layout it doesn't accept, treating it as corrupt; rewriting it in DSH's format brings it back |

Requires Windows (`dsm.exe`) or Node 22.15+ (from source). Handles v0–v4 sessions made by DSH 0.1.2 and later; verified end to end on DSH 0.2.1.

## Quick start

**Windows (recommended):** download `dsm-win-x64.zip` from [Releases](https://github.com/citydirector/dsh-session-manager/releases) and unzip `dsm.exe` (one file with Node built in; nothing else to install).

1. Put `dsm.exe` anywhere (inside the DSH install directory is best, e.g. `D:\dsh-desktop\tools\`).
2. **Quit DSH completely first, tray icon included.**
3. Double-click `dsm.exe` and pick from the menu by number:

```
 1. List sessions              8. Restore from trash
 2. Upgrade old sessions       9. Empty the trash
 3. Clean up empty sessions   10. Clean loops
 4. Archive sessions          11. Repair a broken tail (trim + compact)
 5. Unarchive                 12. Undo the last log change
 6. Archived sessions         13. Repair sessions DSH hides
 7. Move to trash             14. Choose another data directory
```

> `dsm.exe` is not code-signed, so on first run Windows SmartScreen may say "Windows protected your PC": click "More info → Run anyway".
> Upgrading old sessions runs DSH's own migrator, so `dsm.exe` uses the node that ships with DSH (`node\node.exe` in the portable version, the app itself in the desktop version). Nothing else depends on an outside program.

**From source:** clone the repository and double-click `dsm.cmd`. It looks for Node 22.15+ (`DSM_NODE` → the node bundled with portable / desktop DSH → PATH).

## Command line

```bat
dsm list --all                 :: every session, archived included
dsm upgrade                    :: upgrade old-generation sessions
dsm empty                      :: empty sessions → trash
dsm archive 3 5                :: archive by number; a session ID prefix or a title keyword works too
dsm unarchive "qq-bot"
dsm trash 2-4                  :: move to trash
dsm restore                    :: pick what to restore
dsm purge --older-than 30      :: purge trash entries older than 30 days
dsm archived                   :: list archived sessions only; delete some or all
dsm archived rm all --purge    :: purge every archived session (without --purge they go to the trash)
dsm loops                      :: detect and clean loops
dsm tail "qq-bot"              :: repair a broken tail: trim error/retry-only turns, compact offline if still too large
dsm undo                       :: undo the last log change (loop cleanup / tail repair)
dsm repair                     :: repair sessions DSH hides
```

Common options: `--home <data directory>`, `--dry-run` (show, change nothing), `--yes` (no per-item confirmation), `--force` (skip the "is DSH running" check; not recommended).

## Finding the data directory

It doesn't matter where DSH is installed or what the folder is called. dsm looks in this order and uses the first hit:

1. `--home` (the install directory or the data directory; remembered for next time)
2. The `DSH_HOME` environment variable
3. Up from the folder `dsm.exe` sits in, level by level: anywhere inside the install directory works
4. The directory used last time (kept in `%APPDATA%\dsm\config.json`)
5. `~/.dsh` (DSH's official default; the standard install and the npm version both live here)
6. Failing those: Start menu / desktop / taskbar shortcuts that point at DSH, install locations in the uninstall registry, user- and system-level `DSH_HOME`
7. Failing that: a scan three levels down every drive (skipping Windows, AppData and other system folders; a few seconds at most)
8. Failing that: it asks you to drop the install directory into the window

The scan only accepts real DSH data (`storages\workspace.json`, or logs under `sessions\<project>\session-xxx\`), so another program's `data` folder is never mistaken for it. Menu item 14 searches again or takes a directory by hand at any time.

```bat
dsm.exe --home D:\dsh-desktop\data
```

## Repairing a broken tail (`dsm tail`)

Typical symptom: the session grew long, and after a model switch or a context plugin stopped working, every retry fails with `maximum context length` / `prompt is too large`, and even `/compact` fails (the compaction request itself has to carry the whole history).

`dsm tail` lists how the last dozen or so turns ended (completed / aborted / errored), with reply counts and sizes, suggests a cut point (the last turn where the model really produced a reply), and then:

1. **Trim:** turns after that point that hold only errors, retries and empty aborts are cut off whole (the log is truncated at the tail, so seqs stay contiguous). Sub-agent sessions opened in those turns go to the trash with them.
2. **Compact offline:** if the estimated context is still above about 250k tokens after trimming, it calls no model at all. Using DSH's own compaction events (`compaction/start → compaction/summary → checkpoint user/message (surface replace) → compaction/end`), it replaces the older turns with one extractive checkpoint: each turn's user request, the assistant's final reply, and the files written. The most recent turns (about 120k tokens) stay verbatim. Not a word of the full log is deleted; you can still scroll back through the history in DSH.

Both steps back up the original log and projection cache first, and `dsm undo` restores them. Verified on a real DSH 0.2.1: the repaired session resumes normally, and the next request carries only the system prompt, the checkpoint and the kept turns.

> After repairing, open the session and check the model menu first: trimming goes back to the model selected at the cut point, which may no longer be available.

## Security

- **DSH must be fully closed.** DSH's JSONL backend allows a single writer, and DSH holds the ledger (`workspace.json`) in memory. Tested: an archive changed from outside while DSH runs is **silently overwritten** the next time DSH writes the ledger. So every modifying operation checks for a DSH process first, and if it cannot tell, it assumes DSH is running (fail closed).
- **Log contents are rewritten by only three operations:** loop cleanup, frame repair and tail repair (trimming only removes events at the end; compaction only appends). All three back the original up to `<data directory>\.dsm\backups\<time>\` first and verify after writing (same event count, decodes fully, valid frame layout).
- **The trash deletes nothing:** the whole session directory, projection cache included, moves to `<data directory>\.dsm\trash\<time>\`, a new batch each time that never overwrites an older one. A restore whose target already exists is refused; two histories are never merged.
- **Ledger backups:** every write to `workspace.json` leaves a copy in `.dsm\backups\<time>\` first.
- The workspace directory is always read from the session log header, never guessed from the lossy project folder name. The projection cache (`session_projcache`) is derived data: it moves with its session and is never edited.
- Upgrades use DSH's own migrator (`app\migrate-sessions-v4.mjs` in the portable version, `resources\dsh-build\migrate-sessions-v4.mjs` in the desktop version), run serially with `--jobs 1`: migrating in parallel makes parent and child sessions trip each other's `generation changed during verification`. Without a migrator (the standard install usually has no separate one), point at one with `--migrator <path>`, or open the old sessions in DSH one by one and let DSH upgrade them.

## DSH format details

1. **`session.v4.jsonl.zstd` is a multi-frame file:** the header is one frame, and every append adds another. Node's `zlib.zstdDecompressSync` **decodes only the first frame**, so reading with it gets you just the header line. This tool decodes frame by frame.
2. **The first frame must be exactly one header line:** when listing sessions DSH decodes and checks only the first frame, and if it fails the session is treated as corrupt: **not shown, no error**. Writing a whole log back as a single frame (as many third-party tools do) makes the session "disappear"; `dsm repair` brings it back.

## Development

```bash
npm test                                  # unit tests
node scripts/build-exe.mjs                # build dist/dsm.exe (Node SEA; builds the Windows exe on Linux or Windows)
node scripts/smoke-exe.mjs dist/dsm.exe   # smoke test of the built exe, including "refuse while DSH runs"
```

GitHub Actions runs the unit tests, the build and the smoke test on `windows-latest`, and publishes `dsm-win-x64.zip` when a `v*` tag is pushed.

The unit tests cover every operation on synthetic DSH layouts. It was also verified end to end on DSH `0.2.1-rc.2`, with old sessions made by `0.1.2-rc.1`, `0.1.6-alpha.2`, `0.1.7-rc.2` and `0.2.0-rc.2`: DSH restarted after each step, sessions, generation state and blank flags checked through DSH's own `session/list`, and new messages sent to upgraded and cleaned sessions.

## Related projects

- [dsh-remote-access-proxy](https://github.com/citydirector/dsh-remote-access-proxy): Use DSH from your phone, tablet, or another computer
- [deepinfra-fusion-proxy](https://github.com/citydirector/deepinfra-fusion-proxy): DeepInfra Standard / Flex switching with automatic fallback, per session
- [dsh-loop-rescue](https://github.com/citydirector/dsh-loop-rescue): Cut model repetition loops mid-stream, prune them from the log, and resume

## License

[MIT](LICENSE)
