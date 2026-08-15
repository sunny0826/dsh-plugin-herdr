# dsh-plugin-herdr

Herdr control-plane plugin for DeepSeek Harness (DSH): observe and drive
[Herdr](https://herdr.dev) — a terminal workspace manager for AI coding agents —
from DSH sessions.

- **14 `herdr_*` tools**: snapshot, agent list, pane run/read/split/send-keys,
  agent wait/prompt/explain/send-keys, workspace create, pane layout, layout
  apply, notification — over the Herdr CLI or the socket protocol.
- **Herdr panel**: a workspace → pane list view in the conversation page
  (built on the DSH design system), plus a right-side pane status list with
  drag & edge snap and a collapsed logo button.
- **herdr mode (agent preset)**: create a session in "Herdr 模式" — the session
  binds to its own Herdr pane and reports working/idle state to the Herdr
  sidebar.
- **Server dashboard**: checks whether the headless Herdr server is running and
  offers a one-click start button (new-session and session pages).

## Install

Prerequisites: a DSH profile (e.g. `web`) and the `herdr` CLI on PATH.

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
| `cliPath` | string | `herdr` | herdr binary (or `HERDR_BIN_PATH` env) |
| `socketPath` | string | – | socket transport path (`HERDR_SOCKET_PATH`); POSIX only |
| `session` | string | – | herdr session name (`HERDR_SESSION`) |
| `transport` | `cli` | `socket` | `cli` | transport backend |
| `timeoutMs` | number | 30000 | per-command timeout |
| `allowBackground` | boolean | `false` | expose `run_in_background` on pane run |
| `events.enabled` | boolean | `false` | subscribe to Herdr events (socket transport) |
| `events.maxReconnectMs` | number | 30000 | event subscription reconnect cap |
| `reportState` | boolean | `true` | report DSH→Herdr state inside a pane (`HERDR_ENV`) |

CLI/socket transport limits (CA-014):

- Per-command output is capped at 1 MiB per stream on both transports;
  `pane_read`/`pane_run` report `truncated: true` when the cap is hit (socket
  additionally surfaces the server-reported `truncated` flag).
- CLI commands are spawned as a detached process group on POSIX; on
  timeout/abort the whole process tree is killed (no leftover `sh -c`
  children). Windows only terminates the direct child.

Platform support: the CLI transport (`sh -c` wrapping, process groups,
Unix-domain sockets) is **POSIX-only**; on Windows the plugin does not guess a
named-pipe socket path and falls back to the CLI transport, which is not
supported — use POSIX (macOS/Linux) for full functionality.

Example patch (`cordis.patch.yml`):

```yaml
- id: dsh-plugin-herdr-client
  name: dsh-plugin-herdr/client-entry
  config:
    cliPath: herdr
    timeoutMs: 15000
- id: dsh-plugin-herdr
  name: dsh-plugin-herdr
  config:
    transport: cli
```

## Tools

| Tool | Description |
| --- | --- |
| `herdr_snapshot` | Session snapshot: workspaces, tabs, panes, agents, focus |
| `herdr_agent_list` | List agents (filter by workspace / status) |
| `herdr_pane_run` | Run a shell command in a pane; waits for output to settle |
| `herdr_agent_wait` | Wait for an agent to reach a state |
| `herdr_workspace_create` | Create a workspace |
| `herdr_pane_split` | Split a pane (direction/ratio/cwd/env) |
| `herdr_pane_send_keys` | Send key presses to a pane |
| `herdr_pane_read` | Read pane terminal output (visible/recent) |
| `herdr_pane_layout` | Read a pane's layout |
| `herdr_layout_apply` | Apply a declarative layout (socket transport only) |
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

## Safety boundary

- All actions are local to your machine; the plugin shells out to the `herdr`
  CLI or talks to the local socket.
- The panel endpoints (`/herdr-status`, `/herdr-start`,
  `/herdr-session-pane`) are plain HTTP on the local web server — do not
  expose the DSH web port publicly. They are additionally guarded (CA-007):
  - strict methods: `/herdr-status` & `/herdr-session-pane` are GET-only,
    `/herdr-start` is POST-only (otherwise `405 + Allow`);
  - local-context only: `Host` must be `localhost`/`127.0.0.1`/`::1`
    (DNS-rebinding defense); cross-site `Origin` or `Sec-Fetch-Site: cross-site`
    is rejected with `403` (CSRF defense) — unauthorized requests cannot start
    the herdr server or read terminal/topology data.
- State reporting is display-only: it does not affect Herdr's own wait or
  notification semantics.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "herdr CLI not found" | Install herdr: `curl -fsSL https://herdr.dev/install.sh | sh` |
| Tools fail with `HERDR_UNAVAILABLE` | Start the Herdr headless server (or use the panel's start button) |
| Layout tools fail on CLI transport | `herdr_layout_apply` requires `transport: socket` |
| No "Herdr 模式" preset | Check `$DSH_HOME/.agent-presets/herdr/` exists (plugin recreates it on load) |

## Development

```sh
pnpm install
pnpm build        # tsdown (node entries + web client bundle)
pnpm quality      # CA-010 质量门：typecheck + gen-types 漂移检查 + unit tests
pnpm test         # unit tests (node --test)
pnpm test:integration  # build + run.mjs + extended.mjs + events.mjs (真实 herdr，前置不满足时 SKIP)
pnpm gen:types    # regenerate protocol types from the herdr schema fixture
```

## Compatibility

- Verified against **herdr 0.8.0 / protocol 19 / schema_version 1** (the
  fixture `test/fixtures/herdr-api.schema.json` matches live `herdr api schema`;
  `pnpm gen:types:check` fails on drift).
- Acceptance status is tracked in `TASKS.md` (三态：实现 / 自动验证 / 人工验证);
  real-browser visual items (M0-06 HMR, M1-10, M3-05, M7/M10-M12) remain
  manual pending — automated coverage lives at the logic layer (CA-016).
