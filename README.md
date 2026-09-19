# gTabs for Helium

A personal fork of [gTabs](https://github.com/vaddisrinivas/gtabs) for Helium on macOS. It organizes native browser tab groups. Your right-side vertical tabs, Command-S toggle, and auto-hiding top bar stay under Helium's control.

## Install

1. Build this fork or obtain its `gtabs-extension.zip`. Extract the ZIP into a permanent folder.
2. Open `chrome://extensions` in Helium, enable **Developer mode**, then select **Load unpacked** and choose the extracted folder. For a local build, choose `dist/`.
3. Pin gTabs from Helium's extensions menu if you want its toolbar button visible.
4. Open gTabs → **Settings**. Choose **OpenRouter** or **OpenAI-compatible proxy**. Enter the model ID, API key, and, for a proxy, API base URL. No provider is configured by default.
5. Click **Save provider** and allow access to the selected API host. **Save and test** also sends a small connection-test request. A saved configuration does not prove the endpoint or credentials work.
6. Click **Organize** in the popup. Grouping starts immediately and continues in the background if the popup closes. **Undo last grouping** restores the last operation in its original window.

The custom base URL includes any API prefix, such as `/v1`. gTabs appends `/chat/completions` and removes trailing slashes. HTTP localhost, `127.0.0.1`, LAN hosts, and HTTPS endpoints are supported. Leave the key blank only if the endpoint accepts unauthenticated requests. A local proxy may forward requests to a remote model.

Provider profiles retain their own URL, key, and free-form model ID when switching providers. Keys are stored in local extension storage, excluded from settings sync and exports, and never included in error bodies. Profiles are not encrypted. Host access is requested from the Save button for the chosen host; Chrome host permissions cover all ports on that host. Redirects are rejected so requests cannot silently move to another endpoint.

## Automatic organization

In **Settings → Behavior → Automatic organization**, choose **Every five minutes**, **Daily**, **Weekly**, or **Off**. Five minutes is the default for a fresh install, but no alarm or AI request runs until a complete provider configuration and host access are available. Existing saved Off, daily, and weekly choices are preserved.

Automatic runs process each normal window separately and only organize eligible ungrouped tabs. They preserve existing/manual groups, pinned tabs, and protected groups. Identical tab sets skip model requests. Manual Organize uses the window where you clicked; **Protect Existing Groups** is enabled by default and controls whether manual runs may regroup existing tabs. New tabs join matching existing groups without changing those groups' names, colors, or collapsed state.

The interval is approximate. Browser sleep and shutdown delay alarms. gTabs checks and restores missing alarms when the worker or browser starts, and leaves an existing alarm's next run intact. The older threshold automation runs only when the schedule is Off; disable it too if you want all automatic AI organization stopped. Daily/weekly time uses the browser's local time; weekly repeats every seven days from the next selected hour.

No tab closing, deduplication, purging, snoozing, or automatic pinning is part of Organize. Those existing tools remain separate in Settings. This fork is disabled in incognito windows. Eligible tab titles and URLs are sent to the configured provider; browser-internal pages and pinned tabs are excluded from organization.

Only one organization or undo operation runs at a time. Model output is validated before application, and changed, closed, moved, or manually grouped tabs are checked again before applying. API or validation failures leave the arrangement untouched. Browser application errors trigger rollback, with Undo retained if recovery fails. Browser APIs are not transactional, so a browser crash or a concurrent user change can prevent complete recovery. Undo history survives worker restarts but is cleared when the browser exits because tab IDs may be reused. Undo affects only the last applied window's tabs; it skips tabs subsequently navigated, pinned, moved to another window, or reassigned to another group.

## Build and verify

Use Node.js 24 and pnpm 11.25.0. There are no runtime dependencies.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm package
```

The unpacked extension is in `dist/`; the ZIP is `gtabs-extension.zip`. `pnpm dev` rebuilds on changes; reload the extension in the browser after rebuilding. CI runs tests, typechecking, and the build. There is no lint configuration or lint command.

The package lock was imported into `pnpm-lock.yaml` without dependency upgrades. esbuild's existing install script is explicitly allowed in `pnpm-workspace.yaml`.

Tests exercise mocked browser APIs and OpenAI-compatible responses, including optional authentication, permission denial, invalid output, timeouts, overlapping triggers, window boundaries, and undo. Chromium extension smoke verification and release limitations are recorded in [docs/verification.md](docs/verification.md). Real OpenRouter/proxy access needs your chosen endpoint and credentials. Helium UI behavior must also be checked on your Mac.

Known model cost estimates are inherited from upstream. Unknown/custom model prices are not available, so the spending-cap estimate cannot enforce a provider-side budget for those models. Set budgets with your provider if needed.

## Shortcuts and recovery

- `Command-Shift-G` on macOS starts Organize; `Command-Shift-Z` undoes the last grouping. Other platforms use Ctrl.
- `Command-S` remains Helium's native vertical-tab control.
- If a worker stops mid-run, reopening the popup reports the interruption. Inspect your tabs, use Undo if available, then retry.
- If host permission is denied or revoked, open Settings and click **Save provider** to request it again.

[Report an issue in this fork](https://github.com/ahmadhajji/gtabs/issues). Original project by [vaddisrinivas](https://github.com/vaddisrinivas/gtabs); see [LICENSE](LICENSE).
