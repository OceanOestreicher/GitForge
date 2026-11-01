# Repository data retrieval performance — November 1, 2026

The intended startup requirement is to retrieve initial data for every restored repository before displaying the app window. After startup, periodic checks remain limited to the active repository. These measurements describe the current implementation; this investigation did not implement the revised startup gate or eager diff preparation.

## Method

- Profiled the actual `openRepository`, `snapshot`, and `diff` functions, with temporary timing instrumentation. Application source was not modified for profiling.
- Measured the working GitForge repository five times and two generated local Git fixtures three times each. Fixtures were deleted afterward. No remote requests were made and no repository changes were made to GitForge by the profiler.
- “Initial” means a new application metadata cache, including repository validation and the first 200 history entries. It does **not** mean an emptied Windows filesystem cache. “Repeat” means a subsequent snapshot using that metadata cache.
- Times are elapsed wall-clock times on this Windows machine. They include Git process creation, scheduling, I/O, and output processing. CPU-only measurements are identified separately.
- Independent Git queries overlap. Do not add individual command durations, or independently calculated phase medians, to estimate total elapsed time.
- There was substantial run-to-run variability. GitForge initial loads ranged from 280 to 2,187 ms; repeated snapshots ranged from 74 to 1,002 ms. The samples identify cost centers, not guaranteed loading times.

## Basic repository retrieval

| Repository | Shape | Initial load, median | Cached refresh, median | Git processes: initial / refresh |
| --- | --- | ---: | ---: | ---: |
| GitForge | 42 commits loaded, 3 local branches, 1 remote branch, 11 changed file versions | 547 ms | 306 ms | 16 / 5 |
| Working-tree fixture | 2,000 tracked files, 110 changed files, 1 branch | 778 ms | 344 ms | 15 / 6 |
| Reference fixture | 201 commits, first 200 loaded, 21 local branches, 30 tags, no changed files | 3,857 ms | 52 ms | 63 / 4 |

Diff content is not included in these totals. The current snapshot collects changed-file lists and their versions; it does not retrieve their diffs.

## Tasks ranked by initial cost in GitForge

| Rank | Task | Median | What happens |
| ---: | --- | ---: | --- |
| 1 | History, branch comparisons, and stash metadata | 404 ms | Read history, associate branch/tag labels, identify remotes, calculate ahead/behind counts, and list stashes. Some operations run concurrently, but history also chains several Git processes. |
| 2 | Repository validation | 56 ms | Check whether the repository is bare and resolve its root directory. These are two sequential Git processes. |
| 3 | Initial identity, references, and working-tree status | 52 ms | Retrieve current branch/HEAD, branch/tag references, and staged/unstaged/untracked status; read relevant configuration. These operations overlap. |
| 4 | Changed-file versions and index entries | 29 ms | Read index blob IDs for changed files, then inspect file modification/change timestamps and sizes. |
| 5 | Conflict and pending-merge checks | 0.20 ms | Read local conflict-session and merge metadata. This fixture had no active conflict; constructing a conflict editor is a different workload. |
| 6 | Build commit graph data | 0.10 ms | CPU-only preparation of graph paths for the loaded commits; excludes React rendering and browser layout. |
| 7 | Serialize the repository snapshot | 0.03 ms | `JSON.stringify` only; excludes IPC transfer, renderer reconciliation, layout, and paint. |

On repeated GitForge refreshes, cached history/branch/stash work falls to approximately **0.04 ms**. Identity/reference/status queries become the dominant group at **278 ms**, followed by changed-file/index version checks at **29 ms**.

For the 110-change fixture, changed-file version/index checks were 65 ms on initial retrieval. Index queries are batched to respect Windows command-line limits. Their timing and initial status timing were variable; neither necessarily dominates every refresh.

## Why branches and tags are expensive

The reference fixture spent a median **3,510 ms** in history/branch/stash metadata work, accounting for most of its **3,857 ms** initial load.

- Each local branch currently gets its own ahead/behind count query. The fixture issued 21 such queries concurrently. Concurrency prevents simply adding their durations, but still creates substantial process and resource pressure.
- Each tag currently gets a separate `git rev-parse <tag>^{commit}` query while constructing history labels. The 30 tag queries run sequentially and accounted for a median **1,556 ms** of command elapsed time.
- Initial history construction also checks HEAD and enumerates references that are already queried elsewhere in the snapshot flow.

The practical optimization targets are bulk tag peeling/reference retrieval, fewer repeated identity queries, and controlled concurrency for branch comparisons. This workload is expensive despite having only 201 commits; it is not simply a large-history problem.

## Cost of preparing every working-change diff

These are additional timings, measured after repository retrieval. The current renderer cache was bypassed so each diff was actually retrieved.

| Repository | File versions | Sequential preparation | Four concurrent workers | Approximate text storage |
| --- | ---: | ---: | ---: | ---: |
| GitForge | 11 | 411 ms | 68 ms | 110 KiB |
| Working-tree fixture | 110 | 8,105 ms | 4,451 ms | 28 KiB |
| Reference fixture | 0 | — | — | — |

The 110-change fixture contains 100 tracked-file diffs and 10 untracked files. Tracked diffs each start a Git process; untracked files are read directly. Even tiny diff output therefore has a significant retrieval cost when many files change.

The sequential and four-worker figures are individual runs, not multi-run medians. They demonstrate scale and resource cost; the precise speedup should not be generalized.

Parsing 50,000 synthetic diff lines took approximately **5–7 ms** of CPU time. This excludes creating thousands of DOM elements and browser layout/paint, so it does not establish how quickly that entire diff can first appear onscreen. Parsed rows and DOM also consume additional memory beyond the text-storage figures above.

## Implications for startup behavior

1. Waiting for initial snapshots of all repositories is feasible, but repositories with many branches/tags can dominate the startup gate. Running asynchronous work avoids blocking the JavaScript event loop while Git runs; it does not remove CPU/disk contention or the total wait before showing the window.
2. Waiting for every diff as well is a materially stronger requirement. A repository with 110 small changes added 4.45 seconds of diff preparation alone in this experiment. That work is separate from the 0.78-second initial snapshot.
3. If every displayed file must have its diff ready before interaction, the startup gate needs to include those diffs. New files discovered after startup and files first shown when inspecting a commit create the same readiness decision later.
4. Once a diff has been loaded, retaining its previous contents while a new version is prepared is straightforward. For a file with no previous cached diff, showing no loading state requires either preparing it before enabling interaction or waiting to switch the view until preparation finishes.
5. The existing diff cache is capped at 64 entries and 16 MiB of text. Preparing 110 diffs while retaining that cap cannot guarantee all 110 remain immediately available: older entries will be evicted. An all-files-ready policy therefore needs a corresponding cache-retention and memory policy.
6. The biggest performance targets before committing to an all-data startup gate are bulk branch/tag retrieval and reducing the Git-process count for diff preparation. Graph calculations and snapshot serialization were negligible in these samples.

The overall startup delay across multiple repositories was not measured here. It cannot safely be inferred by adding these tables or taking only the slowest repository's individual duration: concurrent loads contend for resources.
