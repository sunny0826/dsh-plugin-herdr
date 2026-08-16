# Repository Guidelines

Contributor guide for **dsh-plugin-herdr**, the Herdr control-plane plugin for DeepSeek Harness (DSH): it registers `herdr_*` tools, a Web panel, and the "Herdr 模式" agent preset.

## Project Structure & Module Organization

- `src/` — TypeScript source: `index.ts` (server entry), `client-entry.ts` (client entry), `tools/` (one file per `herdr_*` tool), `events/`, `client/` (transport backends), `assets/` (embedded skill), `client-logic.ts` (pure UI logic, node-testable), `session-mode.ts`, `preset-install.ts`.
- `src/web/` — Web panel (client bundle): `app.tsx` (slot wiring), `herdr-view.tsx` / `pane-list.tsx` / `pane-card.tsx` (panel UI), `mode.ts` (herdr-mode gate, mirrors `html[data-herdr-mode]`), `tab-controller.ts` (Herdr tab DOM marking), `hero-branding.ts` (new-session hero branding: purple input-card border, herdr logo & split headline, MutationObserver marking), `styles.ts` (injected CSS), `logo-path.ts` (shared herdr logo path).
- `test/` — `unit/` (`*.test.ts`), `integration/` (real-herdr `.mjs` scripts), `fixtures/` (herdr API schema).
- `presets/herdr/` — the "Herdr 模式" agent preset; `scripts/` — codegen (`gen-types.mjs`, `embed-skill.mjs`).
- `lib/` — build output (generated, gitignored); `cordis.patch.yml` — runtime plugin wiring.

## Build, Test, and Development Commands

- `pnpm install` — install dependencies.
- `pnpm build` — tsdown: node entries plus the web client bundle into `lib/`.
- `pnpm test` — builds first, then runs unit tests via `node --test`.
- `pnpm test:integration` — integration scripts against a live herdr server; SKIP (exit 0) when unavailable.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm gen:types` / `pnpm gen:types:check` — regenerate protocol types from `test/fixtures/herdr-api.schema.json`; the check fails on drift.
- `pnpm quality` — full gate (typecheck + drift check + unit tests). Run before pushing.

## Coding Style & Naming Conventions

- TypeScript, `strict: true`, ES2022 / NodeNext; automatic JSX for `.tsx` client code.
- Two-space indentation, no semicolons, single quotes; match existing code.
- `camelCase` for values, `PascalCase` for types, kebab-case file names (e.g. `src/tools/pane-read.ts`).
- Comments may be Chinese; keep them short. No linter is configured — `tsc` strict mode is the enforced baseline.

## Testing Guidelines

- Unit tests use `node:test` + `node:assert/strict`, one file per module, named `<module>.test.ts` under `test/unit/`.
- Integration tests are plain `.mjs` scripts that preflight and SKIP gracefully (CA-009).
- No coverage threshold is enforced; new behavior needs tests at the logic layer (visual items stay manually verified, CA-016). Web-side constant drift sentinels (copy text / brand tokens) live in `test/unit/hero-branding.test.ts`; DOM-marking rules are covered by manual + browser verification (design docs archived under `docs/archive/`, gitignored).

## Internationalization (i18n)

The Web panel supports runtime language switching (zh / en); every new user-facing copy must ship both languages:

- **Language source**: DSH's `html lang` is static (`zh-CN`) — the runtime language lives in the `locale` service (LocaleFace: `getSnapshot()` / `subscribe`). The client injects it in `src/web/app.tsx` (`inject = ['slots', 'locale']`) and `hero-branding.ts`'s `setHerdrLang()` mirrors it to `data-herdr-lang` on marked elements; CSS switches copy per attribute (`:lang()` is unreliable).
- **Shared panel dictionary**: `src/web/i18n.ts` is the single source for panel copy — `I18N_KEYS` (key → `{ zh, en }`), `t(key, params)` templating, and `useHerdrLang()` / `getHerdrLang()` / `setHerdrLang()`. New user-visible panel copy goes there with both languages; `test/unit/i18n.test.ts` enforces dictionary completeness.
- **Hero copy constants**: zh + en pairs (e.g. `HERDR_HERO_TEXT` / `HERDR_HERO_TEXT_EN` in `src/web/hero-branding.ts`); add both languages and extend the drift-sentinel tests in `test/unit/hero-branding.test.ts`.
- **Custom agent presets have no i18n** (`preset.yml` `name`/`description` are single strings; built-ins translate via shell locale keys) — the hero-page preset chip and the menu/settings name+description are localized by DOM text replacement (`HERDR_PRESET_NAME_ZH/EN`, `HERDR_PRESET_DESC_ZH/EN`), re-applied by the MutationObserver / TreeWalker.
- The archived interactive prototype (`docs/archive/`) simulates the language switch for manual verification.

## Commit & Pull Request Guidelines

- Conventional Commits: `feat:`, `fix:`, `fix(scope):`, `docs:`, `ci:`, `chore:`; reference acceptance IDs (e.g. CA-010) in the body when relevant.
- **PR titles, PR descriptions and issues are written in English by default** (commit bodies may use zh when the change is zh-scoped).
- Keep internal docs (`docs/`, `DESIGN.md`, `TASKS.md`) out of commits — they are gitignored by design.
- PRs must pass the CI quality gate; the integration job is `continue-on-error` and may be skipped. Describe what changed and why, link issues, and note manual verification.
