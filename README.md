# dsh-plugin-herdr

Herdr control-plane plugin for DeepSeek Harness (DSH): observe and drive
[Herdr](https://herdr.dev) — a terminal workspace manager for AI coding agents —
from DSH sessions.

- **18 `herdr_*` tools**: snapshot, agent list, pane run/read/split/send-keys,
  agent wait/prompt/explain/send-keys, workspace create/close/rename, pane
  close/rename, pane layout, layout apply, notification — all over the Herdr
  socket protocol (JSONL over a Unix-domain socket; the CLI transport has been
  removed).
- **Herdr panel**: a two-column pane-card grid with drag-to-reorder, per-pane
  log preview/expand, rename and guarded close (confirm + self-pane refusal),
  plus a project-directory filter toggle — and a right-side floating pane status
  list with drag & edge snap and a collapsed logo button.
- **herdr mode (agent preset)**: create a session in "Herdr 模式" — the session
  binds to its own Herdr pane and reports working/idle state to the Herdr
  sidebar.
- **Server dashboard**: checks whether the headless Herdr server is running and
  offers a one-click start button (new-session and session pages).

## Install

Prerequisites: a DSH profile (e.g. `web`) and a running herdr headless
server (the panel's start button spawns `herdr server` from PATH — the only
remaining CLI invocation, see "Platform support").

```sh
# local directory
dsh plugin --profile web add /path/to/dsh-plugin-herdr

# tarball (pnpm pack output)
pnpm pack
dsh plugin --profile web add ./dsh-plugin-herdr-*.tgz

# git (locked commit; requires pnpm allowBuilds for the prepare script)
dsh plugin --profile web add git+https://github.com/sunny0826/dsh-plugin-herdr.git#<commit>
```

> **pnpm allowBuilds**: git-hosted installs run the package `prepare` script.
> If pnpm blocks it, add the exact key pnpm printed under `allowBuilds` in
> `<profile>/pnpm-workspace.yaml`, then re-run.

After install, restart the profile. The plugin registers `ctx.herdr`, the
tools, and the Herdr panel; the "Herdr 模式" preset appears in the new-session
picker (copied to `$DSH_HOME/.agent-presets/herdr/` on first load).

## Configuration

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `socketPath` | string | – | herdr socket path (`HERDR_SOCKET_PATH`); POSIX only |
| `session` | string | – | herdr session name (`HERDR_SESSION`) |
| `timeoutMs` | number | 30000 | per-command timeout |
| `allowBackground` | boolean | `false` | expose `run_in_background` on pane run |
| `events.enabled` | boolean | `false` | subscribe to Herdr events |
| `events.maxReconnectMs` | number | 30000 | event subscription reconnect cap |
| `reportState` | boolean | `true` | report DSH→Herdr state inside a pane (`HERDR_ENV`) |
| `projectRoot` | string | – | project directory for panel filtering; defaults to `process.cwd()` (one workspace-root per DSH web instance) |

Output limits (CA-014):

- Per-command output is capped at 1 MiB per stream; `pane_read`/`pane_run`
  report `truncated: true` when the cap is hit (the server-reported
  `truncated` flag is surfaced as-is).

Platform support: the plugin is **POSIX-only** — all control-plane interaction
goes over the herdr Unix-domain socket (JSONL), and the panel's start button
spawns `herdr server` from PATH as the single bootstrap exception. Windows
(named pipe) is **not supported**: the plugin refuses to load without a
resolvable socket path. Use POSIX (macOS/Linux).

Example patch (`cordis.patch.yml`):

```yaml
- id: dsh-plugin-herdr-client
  name: dsh-plugin-herdr/client-entry
  config:
    timeoutMs: 15000
- id: dsh-plugin-herdr
  name: dsh-plugin-herdr
  config:
    timeoutMs: 15000
```

## Tools

| Tool | Description |
| --- | --- |
| `herdr_snapshot` | Session snapshot: workspaces, tabs, panes, agents, focus |
| `herdr_agent_list` | List agents (filter by workspace / status) |
| `herdr_pane_run` | Run a shell command in a pane; waits for output to settle |
| `herdr_agent_wait` | Wait for an agent to reach a state |
| `herdr_workspace_create` | Create a workspace |
| `herdr_workspace_close` | Close a workspace and all its panes — **destructive** |
| `herdr_pane_close` | Close a pane — **destructive** |
| `herdr_workspace_rename` | Rename a workspace (`workspace_id`, non-empty `label` ≤64 chars) |
| `herdr_pane_rename` | Rename a pane (`pane_id`, `label` may be empty/null to clear the name) |
| `herdr_pane_split` | Split a pane (direction/ratio/cwd/env) |
| `herdr_pane_send_keys` | Send key presses to a pane |
| `herdr_pane_read` | Read pane terminal output (visible/recent) |
| `herdr_pane_layout` | Read a pane's layout |
| `herdr_layout_apply` | Apply a declarative layout |
| `herdr_agent_prompt` | Submit a prompt to an agent, optionally wait for a state |
| `herdr_agent_explain` | Explain agent detection state |
| `herdr_agent_send_keys` | Send keys to an agent |
| `herdr_notification` | Show a system notification |

## herdr mode (agent preset)

Select **Herdr 模式** when creating a session. The session:

- binds to a Herdr pane (auto-created via split, or `config.paneId` in
  `presets/herdr/agent.cordis.yml`);
- reports `working` / `idle` to the Herdr sidebar (`pane.report-agent`);
- closes its owned pane when the session is disposed (fixed bindings are only
  released).

## Herdr panel interactions

The conversation-page Herdr tab and the floating right-hand pane list share one
status source (`/herdr-status`), so scope and filtering behave identically
(v2, CA-019..024):

- **Project filtering**: only workspaces under the project directory (config
  `projectRoot`, default `process.cwd()`) are shown; a "仅本项目
  （matched/total）" hint appears when filtered, with a "显示全部/仅本项目"
  toolbar toggle (`?scope=all`) whose choice is kept in localStorage key
  `herdr:show-all-ws`. On empty project scope the panel offers "显示全部".
- **Two-column cards + drag sort**: panes render as a two-column grid; dragging
  the ⋮⋮ handle reorders within a workspace. Order persists in localStorage key
  `herdr:pane-order:<workspace_id>`. Cross-workspace drags are ignored
  (one-off "同 workspace 内排序" hint). Reacts to narrow viewports (<640px →
  single column).
- **Log preview/expand**: card body shows the latest lines with a fade-out;
  "展开" gives an independently scrolling log that auto-follows a working agent
  and offers "复制" (full output).
- **Rename**: ✎ or double-click turns the pane/workspace name into an inline
  input (≤64 chars); clearing the pane name removes it (falls back to title).
  Renames are persisted by herdr server.
- **Close**: ✕ (hover) opens a confirm dialog; a workspace close shows its pane
  count. The dialog and the server both refuse closing the pane that hosts the
  current session (self-pane).

## Safety boundary

- All actions are local to your machine; the plugin talks to the local herdr
  socket (the only subprocess spawn is the optional server-start bootstrap).
- The panel endpoints (`/herdr-status`, `/herdr-start`,
  `/herdr-session-pane`, `/herdr-close`, `/herdr-rename`) are plain HTTP on
  the local web server — do not expose the DSH web port publicly. They are
  additionally guarded (CA-007):
  - strict methods: `/herdr-status` & `/herdr-session-pane` are GET-only,
    `/herdr-start`, `/herdr-close` & `/herdr-rename` are POST-only
    (otherwise `405 + Allow`);
  - local-context only: `Host` must be `localhost`/`127.0.0.1`/`::1`
    (DNS-rebinding defense); cross-site `Origin` or `Sec-Fetch-Site: cross-site`
    is rejected with `403` (CSRF defense) — unauthorized requests cannot start
    the herdr server or read terminal/topology data.
- State reporting is display-only: it does not affect Herdr's own wait or
  notification semantics.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `HERDR_UNAVAILABLE`: "herdr socket not found" | Start the Herdr headless server (`herdr server` or the panel's start button); install herdr first: `curl -fsSL https://herdr.dev/install.sh | sh` |
| Plugin fails to load with "requires a resolvable socket path" | Windows is not supported; on POSIX set `socketPath`/`HERDR_SOCKET_PATH` |
| No "Herdr 模式" preset | Check `$DSH_HOME/.agent-presets/herdr/` exists (plugin recreates it on load) |

## Development

```sh
pnpm install
pnpm build        # tsdown (node entries + web client bundle)
pnpm quality      # CA-010 质量门：typecheck + gen-types 漂移检查 + unit tests
pnpm test         # unit tests (node --test)
pnpm test:integration  # build + run.mjs + extended.mjs + events.mjs + close-rename.mjs (真实 herdr，前置不满足时 SKIP)
pnpm gen:types    # regenerate protocol types from the herdr schema fixture
```

## Compatibility

- Verified against **herdr 0.8.0 / protocol 19 / schema_version 1** (the
  fixture `test/fixtures/herdr-api.schema.json` matches live `herdr api schema`;
  `pnpm gen:types:check` fails on drift).
- Acceptance status is tracked in `TASKS.md` (三态：实现 / 自动验证 / 人工验证);
  real-browser visual items (M0-06 HMR, M1-10, M3-05, M7/M10-M12) remain
  manual pending — automated coverage lives at the logic layer (CA-016).
