# GitForge

A Windows desktop Git client built with Electron, React, and TypeScript.

## Requirements

- Git installed and available on PATH
- Node.js and npm

## Development status

Phase 2 adds opening local repositories, local/remote branches and stashes,
paged commit history, commit metadata, and staged/unstaged file diffs with
path and tree views. Use File → Open Repo to open a repository in a new tab,
or Open on a new tab to use that tab. Periodic repository refresh is planned for Phase 8.

Pull, Push, Branch, Fetch, Commit, and commit context-menu actions remain
placeholders for later phases. Opening and inspecting repositories does not
stage files, change branches, create commits, or contact remotes.

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
