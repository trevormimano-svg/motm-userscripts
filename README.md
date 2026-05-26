# MOTM Userscripts

Public-by-design landing for Tampermonkey / Userscripts userscripts that integrate with MOTM v2.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome / Edge / Firefox) or [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887) (iOS Safari).
2. Click a `.user.js` file's "raw" link in this repo. Tampermonkey detects it and prompts to install.
3. On first run, the script will prompt you for `MOTM_PATREON_INGEST_KEY` (64-hex). Paste it once; stored locally via `GM_setValue`.

## Auto-update

Each script has `@updateURL` pointed at this repo's `main` branch on `raw.githubusercontent.com`. Tampermonkey checks daily.

## Available scripts

- `motm-patreon-ingest.user.js` — Auto-ingest Patreon post bodies during normal browsing on patreon.com. Live mode + operator-initiated catch-up.

## Security

These userscripts contain NO secrets. The Bearer token is collected via `prompt()` at install time and stored in the userscript manager's local storage. The token is scoped to two endpoints (`POST /api/motm/review/{id}/paste`, `GET /api/motm/intel/awaiting-paste`); see `~/.claude/projects/C--Users-mimanot/memory/project_motm_patreon_email_trigger.md` for full token-scoping details.
