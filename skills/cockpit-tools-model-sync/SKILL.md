---
name: cockpit-tools-model-sync
description: Sync the local cockpit-tools reverse-proxy model catalog into the installed DSH cockpit-tools provider bundle.
whenToUse: Use when the user asks to sync, refresh, or update cockpit-tools models, after cockpit-tools upgrades/account changes, or when the DSH model picker differs from the local proxy catalog.
---

# Sync cockpit-tools models

This skill ships separately from the provider bundle. The portable installer stages both under the DSH home. Never assume a machine-specific absolute path.

## Paths

Resolve DSH home as `$env:DSH_HOME` / `$DSH_HOME` when set, otherwise `~/.dsh` (Windows default: `$HOME\.dsh`). The staged files are:

- Provider package patch: `<DSH_HOME>/cockpit-tools-provider/cordis.patch.yml`
- Sync script: `<DSH_HOME>/cockpit-tools-provider/sync-cockpit-models.mjs`
- Exclusion list: `<DSH_HOME>/cockpit-tools-provider/models-exclude.json`

Use Node.js 18 or later. On Windows use `node.exe` from PATH; on macOS/Linux use `node`.

## Workflow

1. Confirm the provider package and sync script exist. If they do not, ask the user to extract the portable kit and run `node install.mjs` first.
2. Resolve the DSH home and the target profile. Do not assume a profile name; default to `web` only when the user has not specified one.
3. Preview before writing:

   ```sh
   node "<DSH_HOME>/cockpit-tools-provider/sync-cockpit-models.mjs" \
     --dsh-home "<DSH_HOME>" \
     --patch "<DSH_HOME>/cockpit-tools-provider/cordis.patch.yml" \
     --profile <profile> --dry-run
   ```

4. If the preview is correct, run the same command without `--dry-run` to apply. To check whether a refresh is pending without writing, use `--check` (exit 0 means synced; exit 2 means update required; exit 1 means an error).
5. Report the model IDs added/removed and the script result. Never print or repeat API-key values.
6. The script reads the local cockpit-tools config and `/v1/models`. If the proxy is stopped or the target host uses a non-default config path, explain the issue and ask the user to start cockpit-tools or provide the config path; do not guess a key or substitute an unrelated endpoint.
7. The sync changes the staged bundle's `cordis.patch.yml`. If the DSH client does not refresh the picker after the bundle is reloaded, tell the user that the plugin package may need to be re-enabled or the DSH client restarted. Do not restart/disable a client without the user's request.

## Safety and mapping

- API key remains local; it is read from cockpit-tools config. The script adds `refs.COCKPIT_TOOLS_API_KEY` to `<DSH_HOME>/.credentials.yaml` only when missing and never overwrites an existing ref.
- Updates touch only the marked provider block and create timestamped backups for changed files.
- `gpt-reserve` is excluded by default because it returned `503 no_available_account`; users can change the adjacent JSON exclusion list.
- Models hidden by cockpit-tools visibility are filtered. Unknown reasoning levels are dropped rather than guessed.
