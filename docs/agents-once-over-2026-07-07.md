# Vibe Forge agents: once-over review (2026-07-07)

Reviewed by Claude Fable 5 at Adam's request before rolling off. Scope: the LIVE agent
set (`packages/forge-agents/personalities/*.md`, 13 personalities) plus the loader,
compose pipeline, daemon consumption, and ADR-003 coordination model. The prototype
tree (`_vibe-forge/`) was surveyed only to establish what is live.

## Verdict up front

The system is genuinely well designed. The strongest choices, worth protecting:
project-agnostic personalities with project knowledge injected at compose time
(project-context + per-agent overrides); the FM-mediated coordination model with
contracts-before-parallel-spawn (ADR-003); explicit trust models treating task text
and peer comments as data, not instructions; per-agent report shapes and When-To-Stop
escalation lists; the done-file/session-memory exit protocol. These match or beat the
patterns I converged on independently in Chronoglyph.

The problems found are drift and inconsistency, not design flaws.

## Fixed in this pass (working tree, uncommitted — review the diff)

1. **forge-master.md posted comments with the wrong field (real bug).** Its dispatcher
   comment curl sent `{"content": ...}`; the hub schema
   (`packages/forge-hub/src/routes/comments.ts`) requires `body` and would 400. FM
   would silently post NO dispatcher comments, violating its own audit-trail rule and
   starving future FM cycles of the `dispatcherHistory` they triage from. Fixed to
   `body`. (Scribe's `"content"` calls are fine — those hit the docs routes, whose
   schema really is `content`. Temper/herald already used `body`.)
2. **forge-master routed to an unstaffed agent.** The capabilities table listed
   `pixel` (UX), which has no live personality — assignment would fail at the
   registry. Removed the row and added an explicit rule: assign only to agents present
   in the workspace state's agent list; tasks needing unstaffed roles (UX, DevOps)
   escalate to a `pending_dispatcher_action` human-attention task instead.
3. **aegis.md predated the hub-API conventions** (Apr 11 vintage): no Hub API section,
   no done file, no Session Memory Protocol, and a "raise a blocking issue" stop rule
   with no mechanism. Brought to the temper/herald convention: findings comment via
   `body`/`authorType: agent`, done file with a CLEAN/BLOCKED result shape, session
   memory (with a security-specific note: never put vulnerable VALUES in memory files,
   only locations), and a concrete blocking mechanism.
4. **loki.md could hang a daemon slot.** As invitation-only counsel it has no done
   file — correct for planning sessions, but a mis-routed daemon dispatch would wait
   forever. Added an "If Dispatched As A Daemon Task" guard: post provocations as a
   comment, write the done file, yield.

`pnpm test` in `packages/forge-agents`: 25/25 green after the edits.

## Recommended, not done (design decisions or bigger surface)

1. **Staff or formally drop `ember` (DevOps) and `pixel` (UX).** They exist only in
   the prototype tree, yet live personalities still hand work toward them: Flux's
   remediation "routes to Ember", Slag's report template lists ember as a fixer. If
   the roles are wanted, port the prototype personalities to `personalities/` with the
   current conventions (hub API via `body`, done file, session memory, trust model —
   temper.md is the best template). If not, sweep the dangling references out of
   slag.md and flux.md. Porting ember is the higher-value of the two: red-team
   remediation currently dead-ends.
2. **Wire the dead compose layers or delete them.** `composeSystemPrompt` supports
   `# Handoff Notes` and `# Current Task` layers, but the daemon spawn path
   (`daemon.ts:902-905`) passes neither — dead plumbing invites false confidence that
   handoffs flow. Either pass `handoffDir`/`taskContext` from the daemon or remove the
   layers until needed.
3. **Single-source the roster.** Three overlapping definitions exist: live
   `personalities/` (13), `_vibe-forge/config/agents.json` (16, self-declared "single
   source of truth" — no longer true), and `agent-manifest.yaml` (stale since Jan).
   Suggestion: generate any roster documentation from `loadBuiltinRegistry()` output,
   and add a deprecation README in `_vibe-forge/config/` so nobody trusts agents.json
   again. The prototype `/forge` command also names a reviewer (`sentinel`) that has
   never existed in either tree — archive the command or fix it to `temper` if it is
   still used.
4. **Session Memory Protocol is missing from slag.md and flux.md.** Red-team
   engagements are exactly the multi-session work that benefits from resumable memory
   (engagement state, tested attack surface, pending retest). Same convention as the
   workers; same "locations, never vulnerable values" caveat added to aegis.
5. **`preferredTools` and `runtimeHints` are advisory-only and unused respectively.**
   The daemon runs `--dangerously-skip-permissions` by default, so the read-only
   posture of aegis/oracle/architect/loki is purely honor-system. If enforcement is
   ever wanted, `runtimeHints` is the natural carrier (e.g. map to `--allowedTools` at
   spawn). Not urgent; worth knowing it is not a security boundary today.
6. **One pattern from the Chronoglyph rounds worth adopting:** agents in concurrent
   multi-agent work should never gate their exit on whole-tree state (a green build,
   a stable queue) — other agents' in-flight work can hold that hostage; verify own
   scope, report, let the orchestrator integrate. The done-file protocol mostly
   enforces this already; adding one sentence to the worker personalities ("your exit
   criterion is your own scope verified + done file written, never whole-tree green")
   would close the gap Chronoglyph hit twice in one day.
