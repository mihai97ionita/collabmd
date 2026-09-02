# AGENTS.md

Guidance for coding agents working in CollabMD.

## Start here

1. Read `CONTEXT.md` for product terminology and invariants. Use its terms
   precisely.
2. Read `docs/architecture.md` before moving code or adding imports across
   layers. Check `docs/adr/` before changing a documented decision.
3. Check `git status --short`; preserve unrelated user changes.
4. Find the existing implementation and its callers before editing. Prefer the
   smallest root-cause change.
5. Add or update the nearest focused test for behavioral changes.

`README.md` is the user-facing source of truth for CLI behavior, configuration,
and supported features. Keep it and `.env.example` aligned with user-visible
config changes.

## Runtime and commands

- Node.js 26 (`.tool-versions`, CI, and `package.json` require it).
- Use `npm`; CI uses `npm ci` and this repo commits `package-lock.json`.
- Install: `npm install`
- Build: `npm run build`
- Lint: `npm run lint`
- Full non-E2E check: `npm run check`
- Full suite: `npm test`
- Local app: `npm start` → `http://localhost:1234`
- Split development: `npm run dev:server` and `npm run dev:client`

Run the narrowest relevant check while iterating:

```bash
node --test tests/node/<name>.test.js
npm run test:guardrails
npm run test:browser
npm run build && npx playwright test tests/e2e/<name>.spec.js
```

Use the npm wrappers for final validation because several suites require a
fresh build. Install Chromium once with `npx playwright install chromium` if
needed.

## Repository map

- `bin/collabmd.js`: CLI entry point.
- `src/domain/`: pure rules shared by client and server.
- `src/client/app/`: Vite HTML and browser entry modules.
- `src/client/bootstrap/`: startup and dependency wiring; keep thin.
- `src/client/application/`: workflows and orchestration.
- `src/client/domain/`: pure client rules and transformations.
- `src/client/infrastructure/`: HTTP, WebSocket, browser, persistence, and
  editor adapters.
- `src/client/presentation/`: DOM/UI controllers and views.
- `src/client/export/`: export flows (PDF/image).
- `src/client/styles/`: layered CSS system.

Major directories only; top-level entry modules (`main.js`, editor adapters)
also live under `src/client/`.
- `src/server/application/`: workflows over injected collaborators.
- `src/server/domain/`: server-side rules and models.
- `src/server/infrastructure/`: HTTP, WebSocket, filesystem, git, and remote
  adapters.
- `src/server/shared/`: server-only shared helpers.
- `src/server/auth/`, `config/`, `startup/`: auth, configuration, and
  bootstrapping.
- `tests/node/`: unit tests; `tests/node/integration/`: integration tests.
- `tests/browser/`: Vitest browser tests; `tests/e2e/`: Playwright full-app
  tests.
- `test-vault/`: committed test fixture vault.
- `dist/`, `test-results/`, `.tmp/`: generated artifacts; do not hand-edit or
  commit incidental output.

## Architecture rules

CollabMD is a layered monolith. Keep domain code pure and dependencies inward:

- Client presentation imports domain only; receive application/infrastructure
  behavior through composition.
- Client application may use domain and injected collaborators, not
  presentation/infrastructure adapters.
- Client infrastructure may use domain, but not application or presentation.
- Shared pure helpers belong in `src/domain/`.
- Network, filesystem, git, WebSocket, and browser APIs belong in
  infrastructure.
- Compose layers only in thin entry/bootstrap modules.

`eslint.config.js` enforces the currently durable boundaries. Do not bypass a
restriction; move the behavior to the correct layer or inject a collaborator.
See `docs/architecture.md` for the exact allowed imports.

## Product invariants

- The filesystem is the source of truth for Vault Content.
- Opening or hydrating a file must not rewrite it. Only intentional edits
  produce an Editable Content Save.
- External filesystem/git changes are observations reconciled into live state,
  not collaborator mutations.
- Collaboration sidecars (comments and editor snapshots) are not Vault Content.
- Preserve authentication and authorization on both HTTP and WebSocket paths.
- Treat vault content, paths, HTML, diagram source, git input, and remote
  responses as untrusted at their boundaries.
- The supported deployment is single-instance; do not imply cross-replica room
  state.

## Code and UI conventions

- ES modules, single quotes, semicolons, and no unused variables; prefix
  intentionally unused arguments with `_`.
- Reuse nearby patterns and native/stdlib APIs. Avoid speculative abstractions
  and new dependencies.
- Keep public error responses safe; do not expose secrets, filesystem internals,
  or credentials.
- Put visual CSS in `src/client/styles/`, never inline `<style>` blocks or
  runtime-injected styles.
- Raw colors belong only in `src/client/styles/foundation/themes.css`; elsewhere
  use existing tokens.
- Follow the existing style layers and feature file naming. Run
  `npm run test:guardrails` for CSS/UI changes.
- Preserve keyboard access, focus behavior, responsive layouts, and
  reduced-motion behavior when changing UI.

## Testing and completion

Match tests to the changed boundary:

- Pure/domain behavior → focused `tests/node/*.test.js`.
- HTTP, filesystem, git, startup, or WebSocket wiring →
  `tests/node/integration/`.
- Browser component/DOM behavior → `tests/browser/`.
- Full user flows, routing, collaboration, or visual regressions →
  `tests/e2e/`.

Playwright failure artifacts (traces, screenshots) land in `test-results/`;
inspect them before re-running blind.

Before finishing:

1. Run the focused test(s).
2. Run `npm run lint` and `npm run build` for source changes.
3. Run `npm run check` when the change spans layers or UI behavior.
4. Run relevant Playwright tests for user-visible full-app flows.
5. Recheck `git status --short` and report exactly what changed and which checks
   ran.

Do not update snapshots merely to silence failures; inspect the rendered
change first. Do not commit, publish, alter lockfiles, or regenerate unrelated
assets unless explicitly requested.

---

## Personal fork additions (this branch: feat/review-comment-flow)

This branch adds an AI-agent review loop on top of upstream CollabMD. The
additions live alongside the upstream code and do not alter upstream product
invariants (filesystem is still the source of truth; comments are still Yjs
sidecars, never Vault Content).

### What was added and why

The goal is a local-only loop where an AI agent POSTs a markdown proposal,
a human reviews it in CollabMD's browser UI (zooming diagrams, leaving
line- and diagram-element-anchored comments), and the agent GETs the
proposal back as a single markdown payload with comments woven in.

### Review API

Five HTTP endpoints on the server, wired in
`src/server/infrastructure/http/create-review-api-handler.js` and
dispatched before the generic vault handlers in
`src/server/infrastructure/http/create-request-handler.js`.

The `reviewId` (a slug uuid) is the single capability token — knowing it
is all that's needed to access a review. There is no separate secret.
This is a localhost-only tool; the secret was over-engineering.

- `POST /api/review` — body `{ markdown, title? }` → `201` with
  `{ ok, reviewId, vaultPath, url }`. The `url` is absolute
  (`http://localhost:1317/#file=tmp%2Freview%2F<slug>-<uuid>.md`) so the agent
  can hand it straight to the human.
- `GET /api/review/<id>?resolved=false` → `200 text/markdown`.
  Returns the proposal verbatim followed by `---` and a
  `## Review Comments` appendix. The `X-Review-Url` response header
  carries the human-reviewable URL so the agent can read it from headers
  without parsing the body. Unknown id → `404`.
- `PUT /api/review/<id>` — body `{ markdown }`. Replaces the proposal,
  auto-reconciles comment anchors. `409` if a browser session is live;
  `404` unknown id; `422` empty body.
- `POST /api/review/<id>/threads/<threadId>/reply` — body `{ body }`.
  Appends an `Agent` reply to a thread. Routes through the live Yjs room
  when one is active. `409` live-session conflict; `404` unknown
  review/thread; `422` empty body. Truncation metadata is reported on the
  `200` payload.
- `PATCH /api/review/<id>/anchors` — body `{ moves }`. Atomically moves
  line/text thread anchors to explicit line ranges. `409` active room;
  `404` unknown review/thread; `422` invalid batch; `500` persistence
  failure.

Storage (`src/server/infrastructure/persistence/review-store.js`):
the proposal is written to `<vault>/tmp/review/<slug>-<uuid>.md` (a real
vault file, so the browser opens it natively) and meta
`{ reviewId, vaultPath, createdAt, title }` to
`.collabmd/review/<uuid>/meta.json`. Comments persist through the
existing sidecar store at `.collabmd/comments/tmp/review/<uuid>.md.json`.

Serializer (`src/domain/review-markdown-serializer.js`, pure):
`serializeReviewToMarkdown({ proposalMarkdown, threads, includeResolved })`.
Threads are sorted by anchor line; each renders as
`### Line N — "quote"` (or `### Diagram <elementId> — "quote"` for
diagram-element anchors) with one bullet per message. Messages with
`editedAt` get an `(edited)` suffix. Resolved threads are excluded
unless `includeResolved: true`.

Tests: `tests/node/integration/review-api.test.js` (4 HTTP round-trips),
`tests/node/review-markdown-serializer.test.js` (8 pure cases).

### Comment editing

Comments can be edited in the browser. The vertical slice:

- `src/domain/comment-threads.js` — `editMessageRecord(message, body)`
  returns a new record with `body` replaced and `editedAt: Date.now()`.
  The message record shape gained an optional `editedAt` field.
- `src/client/infrastructure/comment-thread-store.js` —
  `editCommentMessage(threadId, messageId, body)` transacts a
  delete+insert on the Yjs messages array, mirroring `toggleCommentReaction`.
- `src/client/infrastructure/editor-session.js` — passthrough.
- `src/client/application/app-shell/comments-feature.js` —
  `editCommentMessage` + overview refresh.
- `src/client/bootstrap/collabmd-app-shell.js` — wires `onEditMessage`.
- `src/client/presentation/comment-ui/comment-ui-card.js` — Edit button
  on every message + `createEditComposer` (Save/Cancel) + draft capture
  so re-renders don't lose in-progress edits.

### Diagram zoom, pan, and comment mode

`src/client/application/diagram-chrome.js` already shipped zoom (buttons,
Ctrl+wheel, pinch, maximize). Added:

- **Grab-to-pan:** pointerdown starts a `pendingDrag`; only after
  movement exceeds 4px does it become a real drag with pointer capture.
  Below the threshold the pointerup is a clean click (so node-comment
  clicks work). Cursor toggles `grab`/`grabbing` via `.is-grabbable`/
  `.is-grabbing` classes.
- **Comment-mode toggle:** a speech-bubble button
  (`diagram-comment-toggle`, icon in
  `src/client/domain/diagram-action-icons.js`) in each diagram's toolbar.
  When on: `shell.dataset.diagramCommentMode = 'true'`, a hint banner
  shows, the frame gets `.is-comment-mode` (crosshair cursor), and
  drag-pan is disabled on that diagram so every click is a comment
  intent. Esc or clicking the toggle again exits. Mode is per-shell, so
  one diagram can be in comment mode while another pans normally.

`src/client/application/mermaid-comment-anchor.js` (new): a click
detector on the preview element. On click, it finds the enclosing
`.mermaid-shell`/`.plantuml-shell`, checks `data-diagram-comment-mode`,
and if on, builds a `diagram-element` anchor from the clicked
`g.node`/`g.edgePath`/`g.edgeLabel`. The SVG is resolved via
`ownerSVGElement` (not `shell.querySelector('svg')`, which returns the
toolbar icon SVG, not the diagram). The anchor is handed to
`commentUi.openComposerForDiagramElement`, added in
`src/client/presentation/comment-ui/comment-ui-card.js`.

`src/client/infrastructure/comment-thread-store.js` —
`resolveCommentThread` now short-circuits for `diagram-element` anchors
and returns without touching the editor doc. Previously it called
`state.doc.line(undefined)` for diagram threads and crashed the whole
editor session. `createAnchor` now supports a null-fallback so the
markdown session can pass diagram-element anchors through while text
anchors use the default `normalizeSelectionAnchorPayload`.

CSS: `src/client/styles/features/diagram-preview.css` —
`.is-grabbable`/`.is-grabbing`/`.is-comment-mode` cursor classes,
`.diagram-comment-toggle.is-active` highlight, `.diagram-comment-hint`
banner.

### Preview-by-default

`src/client/presentation/layout-controller.js` — `preferredView` default
changed from `'split'` to `'preview'`. Files now open in preview-only,
which is what the review workflow wants (the human reviews the rendered
proposal, not the editor). The view toggle in the top toolbar still
switches to split/editor. Affected tests updated:
`tests/node/layout-controller.test.js`,
`tests/e2e/preview-navigation.spec.js`,
`tests/e2e/diagram-preview.spec.js` (the two e2e tests now explicitly
click the split toggle before asserting split-mode layout — honest test
intent).

### Launch agent (macOS login startup)

A `launchd` agent auto-starts CollabMD on login so the review API is
always available at `http://localhost:1317`.

- **Plist:** `~/Library/LaunchAgents/com.imihai.collabmd.plist`
- **Vault:** `~/.collabmd-vault/` (persistent; review docs live under
  `tmp/review/<slug>-<uuid>.md`, sidecars under `.collabmd/`)
- **Logs:** `~/Library/Logs/collabmd/{out,err}.log`
- **Command:** `/opt/homebrew/bin/node
  /Users/imihai/repos/personal/collabmd/bin/collabmd.js --no-tunnel
  --port 1317 /Users/imihai/.collabmd-vault`
- **RunAtLoad:** true (starts at login); **KeepAlive:** false (no
  auto-restart on crash — re-login or manual kickstart to restart)

Manage the agent:

```bash
launchctl list | grep collabmd                              # status
launchctl kickstart -k gui/$(id -u)/com.imihai.collabmd     # restart after npm run build
launchctl kill TERM gui/$(id -u)/com.imihai.collabmd        # stop until next login
launchctl bootout gui/$(id -u)/com.imihai.collabmd          # uninstall
tail -f ~/Library/Logs/collabmd/out.log                     # follow logs
```

The agent serves the committed `dist/` build. After any code change,
run `npm run build` then `launchctl kickstart -k gui/$(id -u)/com.imihai.collabmd`
to pick up the new bundle.

### MCP tools (`mcp/`)

Two local stdio MCP servers are versioned in this repo under `mcp/` so the
agent loop and the CollabMD server live in one place. Each server is a
self-contained `uv` inline script (no venv needed).

- `mcp/collabmd-review/server.py` — `post_review(markdown, title="")` and
  `get_review(review_id, include_resolved=false)`. This is the agent-facing
  surface of the review API: POST a proposal, get back
  `{ reviewId, url }`; GET the proposal back with the human's comments
  woven into a `## Review Comments` appendix. The `reviewId` is the single
  capability token — no separate secret. Also exposes `put_review_md`,
  `reply_to_comment`, and `reanchor_review_threads`.
- `mcp/agent-wait/server.py` — `wait(seconds, label="")` and
  `wait_for(condition, params, timeout_s, interval_s=2)`. General-purpose
  block/poll used to wait for the CollabMD server to be ready after a
  restart (e.g. `wait_for("port_open", {host,port=1317}, 60)`).

**Single source of truth:** Augment launches the scripts directly from
this repo — no copy is synced into `~/.augment/tools/`, so you only ever
edit `mcp/<name>/server.py`. Register once with:

```bash
./mcp/register.sh     # registers both servers with auggie, pointing at repo paths
```

If `~/.augment/settings.json` still points at the old `~/.augment/tools/`
copies (from before this change), `register.sh` removes the stale entries
first and re-adds with the repo paths. Verify with `auggie mcp list`.

The `collabmd-review` server reads `COLLABMD_URL` (default
`http://localhost:1317`) and points at the launchd-managed instance.

### End-to-end loop (how it is consumed)

```text
1. Agent:  POST /api/review  { markdown }   →  { reviewId, url }
2. Human:  open url in browser
           - file opens in preview-only (no editor)
           - zoom / drag-pan the Mermaid diagrams
           - click Comment toggle → click nodes/edges → post comments
           - select text/lines → post line-anchored comments
           - edit any comment in place (Edit button)
3. Agent:  GET /api/review/<id>             →  text/markdown
           proposal verbatim + ## Review Comments appendix
           (line + diagram-element threads, (edited) markers)
4. Agent:  iterate on the proposal, re-POST under a new uuid
```

### Tests added in this branch

- `tests/node/review-markdown-serializer.test.js` — pure serializer (8 cases)
- `tests/node/integration/review-api.test.js` — HTTP round-trip (4 cases)
- `tests/node/mermaid-comment-anchor.test.js` — anchor helpers (5 cases)
- `tests/node/comment-thread-store.test.js` — diagram-element resolution
  + editCommentMessage (2 cases added to existing file)
- `tests/node/comment-threads.test.js` — `editedAt` field in deepEqual
  (existing test updated for the new record shape)

Run them with:

```bash
node --test tests/node/review-markdown-serializer.test.js \
  tests/node/comment-threads.test.js tests/node/mermaid-comment-anchor.test.js \
  tests/node/comment-thread-store.test.js
node --test --test-force-exit tests/node/integration/review-api.test.js
```

### Conventions specific to this fork

- Keep the review API local-only. The `reviewId` is the single capability
  token; do not expose the review endpoints on a public host without auth.
- Do not write review proposals into the user's real vault; they live
  under `<vault>/tmp/review/` which the global gitignore excludes.
- When changing the serializer, update both the pure tests and the
  integration round-trip — the GET endpoint's body shape is the agent
  contract.
- When changing diagram chrome or the comment anchor detector, verify
  with a live browser probe (`ownerSVGElement` is the reliable SVG
  handle after the chrome moves the SVG into `.mermaid-frame`).
