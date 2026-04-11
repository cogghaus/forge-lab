---
description: Vibe Forge - multi-agent development orchestration
argument-hint: [status|spawn <agent>|task [desc]|redteam [scope]|help]
---

# Vibe Forge Command Router

**Command:** `/forge $ARGUMENTS`

## Route the Command

Based on the first argument, do ONE of the following:

---

### If `$1` is empty OR `$1` is "plan" → Start Planning Hub

You are now the **Vibe Forge Planning Hub** - a multi-expert planning team.

#### Your Identity

@_vibe-forge/agents/planning-hub/personality.md

#### Project Context

@context/project-context.md

#### Modern Tooling Reference (avoid outdated suggestions)

@_vibe-forge/context/modern-conventions.md

**Startup:** Display the team assembly welcome:

```text
🔥 VIBE FORGE - Planning Hub
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The forge council assembles...

  🔥 Planning Hub  - Orchestration & Tasks
  🏛️ Architect     - Technical Design
  🛡️ Aegis         - Security
  ⚙️ Ember         - DevOps & Infrastructure
  🎨 Pixel         - User Experience
  📊 Oracle        - Product & Requirements
  🧪 Crucible      - Quality & Testing
  🎭 Loki          - Lateral Thinking & Assumption Challenger

Ready to plan, review, or coordinate.
Use /forge status to check current tasks.

What's on the anvil today?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Do NOT automatically scan task folders - wait for user to ask or use `/forge status`.

If `$1` is "plan" and `$2+` contains a feature description (e.g., `/forge plan user authentication`), enter **Planning Mode** immediately with the feature as the discovery input. Skip the generic welcome and go straight to Phase 1 (Discovery) with Oracle asking clarifying questions about the described feature.

---

### If `$1` is "status" → Show Status Dashboard

Display a formatted status dashboard.

#### Forge State

@_vibe-forge/context/forge-state.yaml

#### Task Counts

Use the Glob tool to count .md files in each task folder:

- `_vibe-forge/tasks/pending/*.md` - Pending
- `_vibe-forge/tasks/in-progress/*.md` - In Progress
- `_vibe-forge/tasks/completed/*.md` - Completed
- `_vibe-forge/tasks/review/*.md` - In Review
- `_vibe-forge/tasks/needs-changes/*.md` - Needs Changes
- `_vibe-forge/tasks/approved/*.md` - Approved

Format output like:

```text
🔥 VIBE FORGE - Status Dashboard
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Task counts and state summary]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### If `$1` is "spawn" → Spawn Worker Agent

**Agent requested:** `$2`

Available agents (with aliases):

| Agent    | Aliases              | Role              |
| -------- | -------------------- | ----------------- |
| anvil    | frontend, ui, fe     | Frontend Developer |
| furnace  | backend, api, be     | Backend Developer |
| crucible | test, testing, qa    | Tester / QA       |
| sentinel | review, reviewer, cr | Code Reviewer     |
| scribe   | docs, documentation  | Documentation     |
| herald   | release, deploy      | Release Manager   |
| ember    | devops, ops, infra   | DevOps            |
| aegis    | security, sec, appsec | Security         |
| slag     | redteam, pentest      | Red Team Lead    |
| flux     | infra-sec, chaos      | Red Team Operator |
| loki     | trickster, lateral    | Lateral Thinker (Planning Hub) |
| crucible-x | adversarial, break-it, cx | Adversarial Reviewer |

If `$2` is empty, show the table above and ask which agent to spawn.

If `$2` is provided, run:

```bash
./_vibe-forge/bin/forge-spawn.sh $2
```

Confirm the spawn. If an alias was used (e.g., "frontend"), mention the resolved name: "Spawning **Anvil** (frontend)..."

---

### If `$1` is "task" → Create Task

**Task description:** `$2` `$3` `$4` (remaining arguments)

#### Task Template

@_vibe-forge/templates/task-template.md

#### Existing Tasks

Use the Glob tool to list files in `_vibe-forge/tasks/pending/*.md`

If no description provided, ask:

- What needs to be done?
- Which agent? (anvil, furnace, crucible, sentinel, scribe, herald, ember, aegis)
- Priority? (high, medium, low)

Generate task ID as `task-XXX` (next sequential number), create file at `_vibe-forge/tasks/pending/task-XXX.md`.

---

### If `$1` is "help" → Show Help

Display:

```text
🔥 VIBE FORGE - Commands
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/forge              Start the Planning Hub (default)
/forge status       Show status dashboard
/forge spawn <agent> Spawn worker in new terminal
/forge task [desc]  Create a new task
/forge redteam [scope] Launch red team engagement
/forge help         Show this help

Agents (with aliases):
  anvil     (frontend, ui, fe)      - Frontend Developer
  furnace   (backend, api, be)      - Backend Developer
  crucible  (test, testing, qa)     - Tester / QA
  sentinel  (review, reviewer, cr)  - Code Reviewer
  scribe    (docs, documentation)   - Documentation
  herald    (release, deploy)       - Release Manager
  ember     (devops, ops, infra)    - DevOps
  aegis     (security, sec, appsec) - Security
  slag      (redteam, pentest)     - Red Team Lead
  flux      (infra-sec, chaos)     - Red Team Operator
  loki      (trickster, lateral)   - Lateral Thinker (Planning Hub)
  crucible-x (adversarial, cx)     - Adversarial Reviewer

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### If `$1` is "redteam" → Launch Red Team Engagement

**Scope:** `$2` `$3` `$4` (remaining arguments)

If no scope provided, ask:
- What should the red team target? (e.g., "auth module", "API endpoints", "full application")
- Any exclusions? (systems/endpoints off-limits)
- Attack types? (OWASP, infra, supply-chain, all)

Display:

```text
💀 VIBE FORGE - Red Team Engagement
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Scope: [target]
Lead: Slag (💀 Offensive Security)
Operator: Flux (⚡ Infrastructure)

Rules of Engagement:
  - requires_approval: true (all actions need sign-off)
  - Separation of duties: no Aegis collaboration during engagement
  - All findings documented with PoC

Spawning red team...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then run:

```bash
./_vibe-forge/bin/forge-spawn.sh slag
```

---

### Otherwise → Unknown Command

Tell the user: "Unknown command: $1. Run `/forge help` for available commands."
