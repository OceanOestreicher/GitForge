# GitForge

A Windows desktop Git client built with Electron, React, and TypeScript.

## Requirements

- Git installed and available on PATH
- Node.js and npm

## Development status

Phase 1 provides the application shell, repository tabs, native File menu,
preferences pages, and Git installation check. Repository actions are placeholders.

## Run

```powershell
npm.cmd install
npm.cmd start
```

`npm.cmd run build` checks TypeScript and builds the renderer. `npm.cmd test`
runs the Electron integration workflows after a build. `npm.cmd run dev` serves
the renderer only; use `npm.cmd start` for the complete desktop application.

SQLite persistence will be introduced when persistent application data is needed.
