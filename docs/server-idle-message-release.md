# Server idle message release

Tracks: electinfo/craft-agents#98. Builds on the idle runtime policy from electinfo/ops#667.

The existing runtime sweep also releases loaded message histories, including histories
opened in the UI that never created an agent. It replaces `messages` with `[]` and
sets `messagesLoaded = false`; the JSONL file remains authoritative. The next access
hydrates the history using the existing cold-session path.

## Policy

- Uses `CRAFT_SESSION_IDLE_DISPOSE_MS` (default 20 minutes); `0` disables history
  release too. No separate threshold or timer. The existing sweep runs at most
  every 60 seconds.
- History access resets a separate idle clock, so opening an old session never
  causes immediate release. Runtime activity also postpones release.
- Uses all existing runtime busy predicates, plus active viewing (the existing
  workspace viewing tracker), an in-flight history load, and async operations.
- `CRAFT_MAX_LIVE_RUNTIMES` applies **only** to runtimes, not message histories.
- Runtime disposal/pooling semantics are unchanged.

## Durability and readers

Before release, enqueue a fresh history snapshot (including any unqueued late
notifications), flush the persistence queue, then synchronously recheck activity,
viewing, loading, busy state and unflushed writes. An access generation prevents a
same-tick reader from losing its history during the asynchronous flush.

The persistence queue serializes timer-started writes as well as explicit flushes,
waits for in-flight writes even when no debounce entry remains, and retains failed
snapshots for retry. Pending, writing or failed snapshots block history release.
A failure logs an error; it does not change the historical non-throwing `flush` API.

`getSession`/`sessions:getMessages`, send (including `/compact`), title refresh and
transfer summaries lazy-load. Queue replay hydrates before looking up queued IDs;
recovery deduplicates queue entries. Synchronous content/annotation edits, connection
and working-directory guards, auth completion, read markers and background-output
lookups hydrate before reading. Late backend events hydrate before appending.
Cold metadata persistence retains its existing synchronous hydration path. Exports
hydrate/flush before serialization; share/updateShare flush before reading disk and
refuse a snapshot if writes remain unflushed.

## Verification

```sh
bun run --cwd packages/server-core typecheck
bun run --cwd packages/shared tsc --noEmit
bun test packages/server-core
for f in packages/server-core/src/sessions/*.isolated.ts; do bun test "./$f" || exit 1; done
bun test packages/shared/src/sessions/__tests__
```

Offline synthetic measurement (Bun 1.3.9, forced GC between samples): ten histories
of 2,000 messages, ~16 MiB content each. JS heap: 38.59 MiB baseline → 197.03 MiB
resident → 38.74 MiB after release → 38.91 MiB after reloading/releasing all ten.
RSS: 318.77 → 574.26 → 572.66 → 487.79 MiB. This demonstrates reclaimed JS
objects, **not** immediate allocator page return or a production RSS plateau.
The live fixed-workload/RSS watch remains an integration/deployment verification.
Look for `Released N messages for idle session …` in server logs.
