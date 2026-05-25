# ADR-002: Workspace Knowledge Base

**Status**: Accepted  
**Date**: 2026-05-25  
**Authors**: Architecture planning session

---

## Context

FM needs full workspace context at triage time. Agents working in parallel need shared interface contracts. As features ship, project architecture evolves and documentation drifts. No existing mechanism in forge-lab accumulates institutional knowledge or curates it over time.

Core principle: **Remember what matters. Archive what doesn't.**

---

## Decision

### `workspaceDocs` table

Structured knowledge store in the hub DB. All docs are markdown. Status controls visibility in FM's active context.

```typescript
workspaceDocs {
  id: text (PK)
  workspaceId: text (FK → workspaces)
  key: text              // slug: 'architecture-overview', 'adr-003', 'agent-anvil'
  title: text
  content: text          // markdown
  category: enum         // 'architecture' | 'api' | 'pattern' | 'adr' | 'agent' | 'feature' | 'runbook'
  status: enum           // 'active' | 'archived' | 'superseded'
  supersededById: text   // id of replacement doc (nullable)
  supersededReason: text // REQUIRED when status = 'superseded'
  updatedBy: text        // agent name or user id
  updatedAt: timestamp
  createdAt: timestamp
}
```

### Status semantics

| Status | Meaning | In FM context |
|--------|---------|--------------|
| `active` | Current, true, relevant | Yes (Tier 0 for architecture/adr/agent/runbook) |
| `archived` | Complete and done, no longer a live concern | No |
| `superseded` | Was true, something replaced it | No — but supersededReason explains what replaced it |

**Nothing is deleted.** Everything stays in the DB. Status controls what FM reads.

### Context tiers

```
GET /workspaces/:id/context returns Tier 0 only:

Tier 0 — always in FM context:
  workspaceDocs WHERE status='active'
    AND category IN ('architecture', 'adr', 'agent', 'runbook')
  goals WHERE status='active'
  agents (all registered)
  agentInstances WHERE status IN ('spawning', 'running')
  queueDepth: count of pending_agent tasks per assignedAgentId
  recentActivity: last 30 taskHistory events
  recentDecisions: last 15 dispatcher taskComments

Tier 1 — on demand (separate endpoints):
  workspaceDocs WHERE status='active'
    AND category IN ('feature', 'api', 'pattern')
  taskHistory beyond last 30

Tier 2 — audit only (explicit query required):
  workspaceDocs WHERE status IN ('archived', 'superseded')
  taskHistory older than 90 days
```

### Scribe's role

**Scribe** is the agent responsible for keeping the knowledge base current and manageable. Scribe operates in two modes:

**Reactive mode** — triggered when a task completes:
1. Scribe receives `task.completed` SSE event
2. Evaluates: did this completion change something documented?
3. If yes: updates or creates the relevant doc
4. If a prior doc is now outdated: marks it `superseded` with reason
5. Logs decision as task comment

**Audit mode** — triggered by FM or schedule:
1. Scribe reads all active Tier 0 docs
2. Cross-references against recent task completions
3. Identifies drift (docs that contradict current code state)
4. Archives completed-feature docs, supersedes reversed decisions
5. Writes a condensed current-state doc where multiple aging docs covered the same topic

### Authority

| Action | Authority |
|--------|-----------|
| Create/update doc content | Scribe (agentId='scribe') |
| Mark archived/superseded | FM (orchestrator) or Scribe |
| `supersededReason` required | Yes — hub rejects PATCH without it |
| Delete docs | Nobody — permanent audit trail |
| Read all docs (any status) | Any authenticated agent |

### Inter-agent coordination

For parallel work (multiple agents on subtasks of one parent), FM establishes the shared interface contract as a dispatcher comment on the parent task BEFORE spawning parallel specialists. Each specialist's initial prompt includes relevant parent task comments.

Agents leave notes on the parent task for sibling agents. This is async, not real-time. FM prevents coordination conflicts by defining interfaces upfront.

---

## Consequences

**What becomes easier:**
- FM always has current project understanding, not stale or contradictory context
- New agents joining a workspace read the knowledge base and are immediately productive
- Architectural drift is caught and corrected continuously, not at release time
- Superseded decisions have traceable audit trails explaining why they changed

**What becomes harder:**
- Scribe must run as an additional daemon instance
- Knowledge base quality depends on Scribe running reliably
- FM's context loading adds one HTTP round-trip per triage cycle

**Alternatives rejected:**
- File-based docs (project-context.md) — not queryable, not workspace-scoped, not status-controlled
- No knowledge base — FM's context degrades as workspace complexity grows
- External vector DB/RAG — overengineered for current scale; hub DB queryable markdown is sufficient

---

## Related decisions

- ADR-001: Forge Master Orchestrator Pattern
- ADR-003: Inter-agent coordination via task comments  
- ADR-004: Context tiering model for FM
