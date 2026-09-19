# Helium fork verification

## Automated checks

- `pnpm install --frozen-lockfile` completes with the imported lockfile.
- `pnpm typecheck` checks production TypeScript with strict mode.
- `pnpm test` covers organization, provider/settings persistence, permissions, alarms, popup, storage, response validation, and recovery.
- `pnpm build` creates an unpacked Manifest V3 extension in `dist/`.
- No lint configuration is present, so no lint pass is claimed.

## Browser smoke test

Pending the loaded-extension check. Unit tests alone do not verify browser extension integration.

## Owner verification still required

- Load the packaged extension in Helium on macOS and confirm the native vertical tabs, Command-S behavior, and top bar work as expected.
- Choose a provider, save its real endpoint/model/key, and grant the requested host permission. Test permission denial and recovery on Helium's native prompt.
- Run Save and test, then Organize against a small set of ordinary tabs. Check new groups, manual groups, pinned tabs, and Undo.
- Leave five-minute organization enabled, open new tabs in two windows, and confirm each window organizes independently. Disable both scheduled and threshold automation to stop all automatic AI calls.
- Restart Helium and confirm the schedule is restored. Sleep/wake timing is approximate.

No live OpenRouter or user proxy request has been made. Endpoint compatibility, model quality, real pricing, and macOS/Helium UI behavior are unverified until those checks run.
