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
