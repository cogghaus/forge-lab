# Agent Overrides

Place per-agent override files here to customize agent behavior for this project.

## How It Works

When Planning Hub spawns a worker, it appends the contents of
`context/agent-overrides/<agent-name>.md` to the agent's system prompt.
This lets you add project-specific rules without modifying the global
personality files.

## File Naming

Use the canonical agent name (matching `config/agents.json`):

```
context/agent-overrides/
  anvil.md        # Frontend-specific project rules
  furnace.md      # Backend-specific project rules
  crucible.md     # Testing conventions for this project
  ...
```

## What to Put Here

- Tech stack constraints ("Use React Query, not SWR")
- Naming conventions specific to this project
- Files or directories the agent should never touch
- Patterns the agent should follow or avoid
- Project-specific testing requirements

## Example

```markdown
# Anvil Overrides

- Use Tailwind CSS utility classes, no custom CSS files
- All components must be in `src/components/` with PascalCase naming
- Use `shadcn/ui` for base components, don't reinvent
- Never import from `@/lib/legacy/` (deprecated)
```
