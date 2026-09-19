# Helium fork verification

## Automated checks

- `pnpm install --frozen-lockfile` completes with the imported lockfile.
- `pnpm typecheck` checks production TypeScript with strict mode.
- `pnpm test`: 443 tests pass across 10 files, covering organization, provider/settings persistence, permissions, alarms, popup, storage, response validation, and recovery.
- `pnpm build` creates an unpacked Manifest V3 extension in `dist/`.
- No lint configuration is present, so no lint pass is claimed.

## Browser smoke test

Completed on 2026-09-19 with the unpacked production build in Chromium 149.0.7827.55, headless on Linux, using Playwright and an isolated persistent profile. A synthetic localhost endpoint returned OpenAI-compatible responses with a two-second delay; no remote provider or real credentials were used.

Verified against real extension APIs and native browser tab groups:

- The compact popup loads; Settings opens the full options page. Unconfigured Organize reports the missing model without making an API request.
- Save and test connects to the synthetic endpoint with a blank key. A trailing-slash URL normalizes to `http://localhost:11434/v1`; the custom model and URL survive options reload and a complete browser restart.
- Organize applies groups after its popup closes. Pinned tabs and an existing manual group retain their state.
- Manual regrouping with existing-group protection disabled, followed by Undo, restores tab order and original group names, colors, and collapsed state.
- Scheduled organization processes new eligible tabs independently in two normal windows. A repeated alarm with unchanged tabs makes no additional model request.
- The five-minute alarm survives a worker restart without moving its existing next run; deleting the alarm and restarting the worker recreates it. A complete browser restart restores the saved configuration and five-minute alarm, while clearing session-only Undo history.
- Selecting Off removes the organization alarm. Five-minute scheduling can then be re-enabled.

Alarm delivery was accelerated for the smoke test while retaining `periodInMinutes: 5`; this was not a long-running timing or sleep/wake test. The headless browser could not operate the native optional-host permission dialog, so localhost permission was granted through Chrome's extension management API in the isolated test profile. Permission denial is covered by unit tests; the actual permission prompt still needs Helium verification.

Independent specification and standards reviews identified undo-target, routing-lock, status-publication, and protected-name matching issues. The fixes include regression tests.

An unrelated existing Rules → Add rule bug was reproduced and recorded in [issue #2](https://github.com/ahmadhajji/gtabs/issues/2).

## Owner verification still required

- Load the packaged extension in Helium on macOS and confirm the native vertical tabs, Command-S behavior, and top bar work as expected.
- Choose a provider, save its real endpoint/model/key, and grant the requested host permission. Test permission denial and recovery on Helium's native prompt.
- Run Save and test, then Organize against a small set of ordinary tabs. Check new groups, manual groups, pinned tabs, and Undo.
- Leave five-minute organization enabled, open new tabs in two windows, and confirm each window organizes independently. Disable both scheduled and threshold automation to stop all automatic AI calls.
- Restart Helium and confirm the schedule is restored. Sleep/wake timing is approximate.

No live OpenRouter or user proxy request has been made. Endpoint compatibility, model quality, real pricing, and macOS/Helium UI behavior are unverified until those checks run.
