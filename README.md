# GitForge

A Windows desktop Git client built with Electron, React, and TypeScript.

## Run the Windows executable

Double-click `release/GitForge.exe` to start GitForge.
This portable executable includes the application runtime; Node.js, npm, and a
terminal are not required. Git must be installed and available on PATH.
Profiles and the saved workspace remain in the Windows application-data folder.

## Build a Windows executable

With Node.js, npm, and Git installed:

```powershell
npm.cmd install
npm.cmd run dist:win
```

The build creates `release/GitForge.exe` and an unpacked
application in `release/win-unpacked/`. Double-click the portable executable to
run it, or move that executable to another folder. Keep every file together
if using the unpacked application. Build outputs are ignored by Git.
The Preferences sidebar displays the version from `package.json`.
Packaging uses [electron-builder](https://www.electron.build/v26/docs/).

After building, `npm.cmd run test:packaged` checks the packaged runtime using
an isolated test profile and repository.

## Development requirements

- Git installed and available on PATH
- Node.js and npm

## Development status

Phase 2 adds opening local repositories, local/remote branches and stashes,
paged commit history, commit metadata, and staged/unstaged file diffs with
path and tree views. Use File → Open Repo to open a repository in a new tab,
or Open on a new tab to use that tab.

Opening and inspecting repositories does not stage files, change branches,
or create commits.

Phase 3 adds local repository initialization through Create or File → Init Repo.
Enter a repository name, an existing absolute parent directory, and a default
branch. GitForge creates a new child folder with README.md and a starter
.gitignore, leaving both files uncommitted. Existing destination folders are
never overwritten. Creation errors remain visible in the initialization form.

Phase 4 adds profiles under Preferences → Profiles. A profile is required to
use the application. Profiles support creation, editing, switching, and confirmed
deletion. PATs are encrypted with Electron safeStorage (Windows DPAPI) before
being saved in SQLite; profile lists never include tokens. Leaving the PAT blank
when editing preserves it. Deleting the active profile selects the first remaining
profile alphabetically; deleting the last returns to required profile setup.

Phase 5 adds Clone on new tabs and File → Clone Repo. Enter a GitHub HTTPS
clone URL and type or browse for an existing parent directory. The clone is
created at `parent/repository-name` using the active profile credentials.
Existing destinations are never overwritten. Errors keep the form open for
correction and retry; credentials are not stored in the remote URL or Git config.

Phase 6 adds file staging and unstaging (double-click, or select with Ctrl/Shift
and use Stage/Unstage), discarding selected unstaged changes with Delete, and
commits authored with the active profile username and email. Discarding tracked
changes restores the staged version; discarding untracked files deletes them.
Unpushed commit counts appear beside branches and a dot marks repository tabs.
Push publishes commits; the adjacent options menu offers confirmed Force Push.
Missing remote branches and GitHub repositories require confirmation before
creation. Repository visibility is explicitly selected when creating a remote.

Phase 7 adds automatic local refresh (once per second), remote refresh (every
five minutes), Fetch, Pull, and behind counts displayed as `N ↓`. Fetch updates
remote-tracking branches without changing local branches or working files.
Pull fetches the upstream, fast-forwards where possible, and otherwise merges
using the active profile identity. Uncommitted changes block Pull. Conflicting
pull merges open the conflict resolver described below.

Phase 8 adds branch switching, creation from branches or commits, detached
commit checkout, and confirmed branch resets that keep or discard changes.
Dirty branch switches offer discard or stash-and-apply. Branch context menus
support merging and conflict resolution. Selected files
can be stashed with a name, and saved stashes can be applied or deleted through
confirmed context-menu actions. Failed stash applications restore prior changes
and retain the stash when aborted.

Phase 9 adds a two-pane conflict resolver for branch merges, pulls, and stash
application. Choose local, incoming, or both changes for each conflict, then
advance through the remaining conflicts. Resolving stages the results; a branch
merge or pull stays pending until committed. Abort restores the state before the
operation, including staged, unstaged, and untracked changes for stash operations.
Conflict choices survive an application restart. Binary files and deletions can
be resolved by keeping either full version. Fast-forward merges do not create an
extra commit; conflict-free divergent merges create one automatically.

## Error messages

Maintain application error and warning text in `src/messages.ts`. Retrieve static
messages with `Message['branch.name.invalid']`; fill numbered placeholders with
`addData(Message['repository.create.failed'], details, directory)`. Keep wording
in the catalog rather than at call sites. Build and test commands generate the
CommonJS runtime copy in `dist-electron/messages.cjs` for Electron automatically;
edit the TypeScript source only.

## Run

```powershell
npm.cmd install
npm.cmd start
```

`npm.cmd run build` checks TypeScript and builds the renderer. `npm.cmd test`
runs the Electron integration workflows after a build. `npm.cmd run dev` serves
the renderer only; use `npm.cmd start` for the complete desktop application.

Open repository paths are stored in SQLite in the application user-data directory.
On launch, GitForge reopens those repositories using fresh Git data and skips
repositories that are missing or no longer accessible. Closed repositories are
removed from the saved session.
