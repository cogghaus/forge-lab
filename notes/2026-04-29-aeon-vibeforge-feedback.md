# Vibe Forge — observations from Aeon (2026-04-29)

Adam's note: this is a feedback dump from running vibe-forge in anger on the Aeon project (sugar-crash-studios/aeon, Apr 27–29). When you next pick up forge-lab, fold these back into vibe-forge upstream where they belong. Each item has a "what we did locally on Aeon" so you can see the workaround pattern.

The Aeon repo's `_vibe-forge/` is a current clone of vibe-forge tip; all observations come from real worker sessions, not speculation. Where I changed vibe-forge files locally on Aeon, those changes are gitignored (per Aeon's rules) but documented in Adam's auto-memory at `~/.claude/projects/G--dev/memory/reference_vibe_forge.md`.

---

## TL;DR — five upstream changes worth your time

1. **First-class headless-spawn support** (background `claude --print` workers) — the wt-tab model is fragile.
2. **Workers actually poll their queue** instead of "after-task-done, check once."
3. **Self-abort directive baked into personality.md** so headless workers can bail cleanly.
4. **Custom-agent install path that survives `npx vibe-forge update`** — currently `_vibe-forge/agents/` is wiped on update.
5. **Daemon stops re-queuing approved tasks into review/** — workflow bug Temper documented in real time.

Below: each, with what we observed and the workaround applied.

---

## 1. Worker spawn: wt-tabs are fragile; headless `claude --print` is solid

**Symptom:** `forge-spawn.sh <agent>` opens a wt tab running `claude --system-prompt ... startup`. The agent does the first task, reports completion, and **sits idle indefinitely on the completion screen**. The advertised `worker_loop` does NOT continuously poll — empirically it's "after-task-done, check queue once, exit if empty." This means:

- Tasks that land in the queue *after* the agent reported idle are never picked up.
- Daemon-driven moves (e.g. `needs-changes/` arrivals) are ignored.
- The orchestrator (Forge Master) cannot see into the tab — they rely on the user to relay status.
- Tabs die quietly on errors; user only sees the result by clicking the tab.

**What we did on Aeon:** switched to background `claude --print` workers driven from the orchestrator session. Pattern:

```bash
ANTHROPIC_MODEL=claude-sonnet-4-6 \
CLAUDE_CODE_GIT_BASH_PATH="<path-to-bash>" \
claude --print --dangerously-skip-permissions \
  --append-system-prompt-file _vibe-forge/agents/<agent>/personality.md \
  "<task directive>"
```

Run via the harness's `Bash(run_in_background=True)`. Output buffers until completion (`--print` doesn't stream tool calls), but the harness auto-notifies on exit. Multiple agents run in parallel; orchestrator chains dependencies.

Smoke-tested with Furnace on TASK-007 (PR #8): clean end-to-end run, ~10 min wall time, agent caught and fixed 4 unrelated csproj bugs unprompted.

**Upstream fix to consider:** add a `--headless` mode to `forge.sh` that invokes `claude --print` instead of interactive, and document the orchestrator-driven pattern as the recommended autonomy model. The wt-tab interactive flow is still useful for "I want to chat with one agent for a while" but shouldn't be the default for `forge-spawn` autonomous work.

---

## 2. `worker_loop` does not actually poll continuously

**Symptom:** see #1. `worker_loop_enabled: true` is set, but workers exit after one cycle of "task-done, check once." The README and personality docs imply continuous polling; reality differs.

**Workaround on Aeon:** orchestrator drives the loop instead.

**Upstream fix:** either (a) actually implement continuous polling with backoff, or (b) clearly document that worker_loop is "single-cycle" and the orchestrator (or external supervisor) is required for continuous operation. Right now the documentation is misleading.

---

## 3. Self-abort directive for headless workers

**Symptom:** when a worker spins on a task, there's no way for the orchestrator to interrupt a `--print` process mid-flight. Without a self-abort, the worker either:
- Spins forever (or until billing limit)
- Reports a vague failure
- Commits half-broken state

**What we did on Aeon:** wrote `docs/agents/abort-directive.md` (in Aeon) with a structured self-abort:

- **Triggers:** tool-call budget without commit (50), repeat-attempts (3), missing-dependency (immediate), self-judgment.
- **Protocol:** stop work, stash dirty tree, return task to pending/, write structured `attention/TASK-NNN-abort.md` artifact, exit non-zero.
- **Artifact template:** task ID, reason, what-was-tried, specific blocker, working-tree state, recommendation for re-spin.

Result: orchestrator gets a clean failure with enough context to re-spin without re-reading the worker's transcript.

**Upstream fix:** bake this pattern into every personality.md file (or a shared base personality). Workers should know how to fail cleanly. The abort artifact format should be standardized so orchestrators can parse it.

Aeon's full directive is at `G:\dev\aeon\docs\agents\abort-directive.md` — feel free to copy verbatim.

---

## 4. Custom agents get wiped on `npx vibe-forge update`

**Symptom:** Aeon needed a custom **Loremaster** agent (Game Designer with deep genre wisdom for civ/sim games). We installed it at `_vibe-forge/agents/loremaster/personality.md` and registered it in `_vibe-forge/config/agents.json`. Both are gitignored (per vibe-forge's intent — tool internals). On `npx vibe-forge update`, both files would be wiped.

**What we did on Aeon:** kept the canonical copy at `docs/agents/loremaster.md` (tracked) plus a re-install README at `docs/agents/README.md`. Manual reinstall after every update.

**Upstream fix:** add a `_vibe-forge/agents.user/` directory (or similar) that:
- Is preserved across updates
- Is loaded after the bundled agents (allowing override or addition)
- Has its own user-agents config file that gets merged with `config/agents.json`

This unblocks a real use case (project-specific agent specialization) that's currently friction-heavy.

---

## 5. Daemon re-queues approved tasks into review/

**Symptom:** Temper detected this in real time and wrote `tasks/attention/TASK-001-review-loop.md`:

> "TASK-001 (SimClock) was reviewed and approved three times in a single session. Each time it was moved to `tasks/approved/`, a fresh copy without the review section re-appeared in `tasks/review/` within minutes."

Same happened with TASK-005 and TASK-006 in Aeon.

Hypothesis (per Temper): the daemon scans some source (pending/ or a DB) where `ready_for_review: true` is still set, and re-copies to review/ on each tick. The source's `status` field never gets updated to `reviewed`/`approved` post-review.

**Workaround on Aeon:** Forge Master manually re-removes spurious copies and flips `status: pending` → `status: completed` in frontmatter of completed task files. Friction-heavy.

**Upstream fix:** daemon should check for `## Review` section presence or a `verdict:` key in the completion YAML before re-queuing. Also consider: tasks in `completed/` or `merged/` should be terminal — daemon should never move them back to review/.

---

## Smaller items (also worth filing)

### `$USER` unbound variable on Windows Git Bash

In `_vibe-forge/src/lib/config.sh` line ~276: `[[ -n "$USER" ]]` crashes under `set -u` because Git Bash inside a `wt.exe new-tab` subprocess doesn't reliably inherit `$USER`. Fix: change to `[[ -n "${USER:-}" ]]` and similarly default-guard `${USERPROFILE:-}`. Add a third fallback to `${USERNAME:-}` (Windows-canonical). Applied locally on Aeon; every Windows user without a custom `$USER` in their shell profile hits this on `forge-spawn`.

### `findGitBash()` walks up too few levels

In `_vibe-forge/src/lib/terminal.js`, the `where git` fallback only walks up 2 levels, which fails when `where git` returns the mingw64 path (Git installed at `D:\applications\git\` instead of `Program Files\Git\`). Fix: walk up 3 levels and check `bin/bash.exe` at each ancestor.

### Daemon surfaces non-Aeon tasks to workers

The daemon surfaces files in `tasks/needs-changes/` to workers. In Aeon, vibe-forge legacy task files (`TASK-DASH-001-server-infrastructure.md`, etc.) sat in needs-changes/ from upstream development and Furnace picked one up unprompted, burning quota on a vibe-forge dashboard fix that wasn't Aeon work.

**Workaround on Aeon:** quarantined vibe-forge legacy files to `_vibe-forge/tasks/_vibe-forge-legacy/` so workers don't see them.

**Upstream fix:** vibe-forge should ship without seeded task files in tasks/* directories. Or scope tasks by project (e.g. `tasks/<project-slug>/pending/`) so a project's queue is isolated from vibe-forge's own development tasks.

### Task ID collision

Aeon's TASK-001 and vibe-forge's legacy TASK-001 collided in `merged/` and confused the daemon's counts. Project-prefixed task IDs (e.g. `aeon-TASK-001`, `vf-TASK-001`) would prevent this; or honor a top-level `tasks/<project>/` namespace.

---

## Things that worked great (no fix needed, just confirmation)

- **Personality-file-driven agents** — the markdown personality format works well. Loremaster slotted in cleanly with the same shape as built-ins.
- **Task templates** — the YAML frontmatter + structured-markdown task format is good. Workers parse it reliably.
- **`gh` integration** — agents creating PRs via `gh pr create` works without any vibe-forge plumbing.
- **`tasks/handoffs/` directory exists** — good idea, just underdocumented. We didn't end up using it on Aeon but the slot is there for inter-agent specific guidance.
- **Council / Planning Hub model** — the multi-voice planning session was genuinely useful for Aeon's design phase. The expert personas surfaced real disagreements.

---

## Pointers for when you're back

- Live abort directive on Aeon: `G:\dev\aeon\docs\agents\abort-directive.md`
- Loremaster agent: `G:\dev\aeon\docs\agents\loremaster.md`
- Memory: `~/.claude/projects/G--dev/memory/reference_vibe_forge.md` (the 2 known Windows bugs and the local override of `forge.sh` with `--dangerously-skip-permissions`)
- Aeon repo: `G:\dev\aeon` — see commit history for `chore: housekeeping`, `plan: ...`, and the abort directive doc commit (`533ed41`)

This note isn't urgent — Aeon is shipping fine with the workarounds. But when you next have time on forge-lab, especially #1 (headless-spawn) and #3 (abort directive) would meaningfully improve the autonomy story for downstream projects.
