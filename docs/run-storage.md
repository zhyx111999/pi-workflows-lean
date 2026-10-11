# Run storage protocol

## Files

New writes use a versioned `<runId>.json` head and a `<runId>.json.events.jsonl` log. The head stores routing/status fields, compact agent counts/usage, and the commit it names: the log generation, committed byte boundary, sequence and SHA-256 chain tip. Scripts, arguments, journals, logs, agent rows and results live in log deltas, not the list index. `<runId>.json.bak` mirrors the last successful head write. While a generation switch is in progress, the new log is staged as `<runId>.json.events.<generation>.jsonl`. Unknown format versions fail closed.

Records live only in `~/.pi/workflows/projects/<project>/runs/`, and only this format is read: a record in any other format is refused rather than guessed at. Use `RunPersistence.load()` to obtain a reconstructed full record; do not treat the head JSON as a full record.

Conversation delivery exports `{runId, result}` to an immutable, content-hashed `.json.result-<hash>` artifact. It is a presentation artifact, not an input to resume. This preserves a directly readable full-result link without rewriting the full result on every delivery-marker update.

## Commit and recovery

1. Acquire a short per-run writer mutex. Execution/resume/recovery still use the existing long-lived run lease; the mutex serializes log/head changes and delivery metadata.
2. Derive a delta: changed scalar/object fields and changed array cells, including explicit removal and array length. Unchanged completed journal/agent rows are not rewritten. Comparing an arbitrary full state still visits its cells; this protocol bounds growing-history **write volume**, not that comparison's CPU cost.
3. Finish an interrupted generation switch (see below), discard bytes beyond the previously committed boundary, append the next chained JSON entry, and flush the log write.
4. Write and atomically rename the new head, then best-effort refresh its backup. The head rename is the commit point. Release the writer mutex.

After a process crash before step 4, readers ignore the uncommitted tail. The next writer removes it before appending. A missing or unparsable head can fall back to its backup. A truncated or hash-invalid **committed log** fails closed rather than silently replaying an older paid-call prefix. This is a process-crash/atomic-rename protocol, not a promise of power-loss durability on every filesystem or atomic synchronization across cloud-sync clients.

Delivery markers, session ownership and resume counters append small metadata deltas. Orphan recovery appends an agent-settlement operation under the run lease; hydration later applies the same settlement helper used by the live manager. Startup does not read every historical journal merely to settle stale agent status.

Deletion runs under the writer mutex and removes the recovery candidates first: the backup, so a stale backup never stands in for the head, then the head. Removing the head is the commit point. Only then do the event logs (including staged generation logs), temporary head, exported result artifacts and run log go; run locks are released last. A failure at any step therefore leaves either a complete, loadable record or no record, never a listed head whose log is gone. The failure is reported rather than claiming success, and the manager still releases its own lease. Every step tolerates an already-missing file, so deleting again finishes the cleanup. Retention rechecks terminal status, pending delivery and live lease ownership under the writer mutex. Contended records remain for a later retention pass.

## Compaction

A log only grows within one generation. Before a full save appends, it compares the committed log with the run's serialized size. Once the log is at least 16 KiB and at least four times the run, the save starts a new generation whose log is one snapshot entry of the whole run, instead of appending a delta. A cold load therefore parses at most about four times the current run (or 16 KiB), plus the small metadata entries appended since the last full save. Each snapshot follows at least three times its size in appended history, so snapshots add at most about a third to the write volume. Metadata updates and orphan recovery never read the log; they only append, and the next full save compacts.

A generation switch runs under the writer mutex:

1. Promote a staged log that the current head already names (as every writer does first), then delete any other staged log: its switch never committed.
2. Write the snapshot to `<runId>.json.events.<new generation>.jsonl` and flush it. The current head and its log are untouched.
3. Write and atomically rename a head naming the new generation, then best-effort refresh its backup. The head rename is the commit point.
4. Rename the staged log over `<runId>.json.events.jsonl`. A failure here is not reported: the switch has committed, and the next writer promotes the staged log.

A head's log is its generation's staged file while that file exists, and the final log otherwise. A crash before step 3 leaves the old head with its intact log plus an abandoned staged file, which the next switch or deletion removes. A crash after step 3 leaves the new head with its staged log until a writer promotes it. No step removes or invalidates the committed head, and recovery never relies on a head or backup being unreadable. A backup that still names the retired generation (its refresh failed, or the process died first) fails closed once the snapshot is promoted, until the next commit refreshes it.

Readers take no lock, so a switch can promote or retire the log that a just-read head names. A failed replay re-reads the head and retries, up to three attempts in total; a damaged commit still fails every attempt. A listed view whose head was superseded this way loads its log fields from the current commit.

## Listing and memory

Listings cache lightweight views, not hydrated histories. They enumerate heads and backups and read each run through the same recovery path as `load()`, so a run whose head is missing or unparsable is listed from its backup, and startup recovery and pending-delivery scans see it too. They check directory identity/timestamps after a 300 ms burst cache; atomic head replacement invalidates the directory stamp. A five-second reconciliation catches external in-place edits even when directory timestamps do not change. Changed files are distinguished by inode, size and mtime of the file a reader starts from: the head, or the backup when no head exists. Writers refresh the backup only together with the head, so the head's stamp also covers its fallback.

Full-record hydration is lazy and bounded to eight entries with a 16 MiB serialized-weight budget (an accounting limit, not an exact JavaScript heap measurement). A cached replay is reused only for the exact commit a head names (generation, sequence, byte boundary, chain tip and run ID) and an unchanged log file; anything else replays and validates the log again, so a damaged head fails the same way hot or cold. Caller-owned loaded records are isolated from the cache. The navigator retains one selected historical snapshot, so visiting many details does not indirectly retain all journals through list-cache keys.

Writer locks never busy-wait. Contention is reported to the caller; existing required checkpoint writes fail closed, while ordinary progress writes retain their existing best-effort behavior. Dead-process mutex owners can be reclaimed; malformed mutexes are left intact because they may belong to an in-progress writer. Unsupported/corrupt storage should be preserved for diagnosis, not manually truncated to make resume proceed.
