# Helium fork verification

## Automated checks

- `pnpm install --frozen-lockfile` completes with the imported lockfile.
- `pnpm typecheck` checks production TypeScript with strict mode.
- `pnpm test`: 476 tests pass across 11 files, covering organization, provider/settings persistence, permissions, alarms, popup, storage, response validation, recovery, and Jev classification.
- `pnpm build` creates an unpacked Manifest V3 extension in `dist/`.
- No lint configuration is present, so no lint pass is claimed.

## Jev verification (2026-09-21)

OpenRouter Jev support was checked against OpenRouter's published OpenAPI specification: `POST /api/alpha/decisions` uses the same Choice questions and answers as direct TypeSafe. Tests verify the exact endpoint, OpenRouter authentication, the pinned model and latest alias, smaller 20-tab batches, ordinary chat-model routing, category visibility and persistence, and protection/Undo behavior through both providers.

In a fresh Chromium profile, the built extension's OpenRouter configuration connected to a local synthetic Decisions endpoint. The server received `/api/alpha/decisions` for both Save and test and organization. Two ordinary tabs were grouped; a pinned tab and a collapsed manual group were preserved; Undo restored the original arrangement. All 30 categories were available, the key label read OpenRouter API key, screenshots at 1280x900 and 390x844 were inspected, and no horizontal overflow or console errors were found. No live OpenRouter key was used. Reload the unpacked extension after replacing its files so the service worker uses the new build.

The Jev integration uses the documented TypeSafe Choice request and answer format. Tests cover the 30 presets, custom category persistence, confidence fallback, explicit domain rules, response validation, bounded request concurrency, draining failed batches, token accounting, timeouts, and the classification connection test. Background tests verify that fuzzy title matching cannot bypass Jev and that incomplete answers cause no grouping.

The production extension was loaded in an isolated Chromium profile through Playwright. A local synthetic server implemented `/v1/systemone`; no real TypeSafe key or remote model was used. Save and test connected, all 30 categories persisted through reload, and a real browser organization grouped two eligible tabs into Development while leaving a pinned tab and an existing collapsed Manual group alone. Undo restored both eligible tabs to their ungrouped state. The options page had no console errors. Screenshots were checked at 1280x900 and 390x844; the narrow viewport had no horizontal overflow.

Localhost access was granted through Chromium's extension-management API because the headless browser cannot operate the native optional-host prompt. Unit tests cover permission requests and denial. Real TypeSafe latency, classification quality, and Helium's permission prompt remain owner checks.

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
