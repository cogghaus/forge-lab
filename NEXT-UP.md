# Next Up

## Security findings - forge-hub (logged 2026-08-26)

**Status 2026-10-05: findings 1-6 FIXED in `0a7cde5`, each with a regression test.** Deploy note:
forge-hub now refuses to boot in production without `FORGE_HUB_WAKER_TOKEN` (compose passes it;
the accserver `.env` has it). `cookieSecure` defaults to true and accepts only `1/true/0/false`.

### Follow-ups found while fixing (not yet fixed)

- `GET /agents/:id` returns workspace-scoped agents (incl. personality) to any logged-in user: same IDOR class as finding 1.
- Docs POST/PATCH from a device check Heimdall policy only, not the device owner's membership; `GET /tasks?workspaceId=` skips membership for devices by design (`tasks.ts:702`). Same class as 1 and 3.
- Agent memory on tasks with NO workspace is reachable by any device sharing the agentId. Needs a decision (e.g. restrict to the task creator).
- `forge-mcp/src/tools/knowledge.ts:19,33,53` calls `/docs` and `/docs/:id`, which match no hub route; its docs tools may already be broken.
- `forge-daemon` config boolean parsing turns any string other than `false`/`0` into true (`'no'` is true): same footgun as finding 5.
- accserver `forge-lab-deploy.timer` has failed every run since at least 2026-08-24: `/datapool/docker/forge-lab/ghcr.env` missing (needs `GHCR_USER` + a `read:packages` token). Production is still on `e7c196e`.

---

Source: a dual-agent security review of `packages/forge-hub/src` (two independent reviewers on different model tiers). The top finding was reported by BOTH reviewers, so it is high-confidence. To be addressed next time work happens in this repo. Each fix should ship with a regression test.

### HIGH

1. **IDOR on workspace docs reads** - `routes/docs.ts` (GET list ~128-163, GET by key ~166-198). Both GET endpoints check only authentication, not workspace membership; `workspaceId` comes straight from the URL. Any authenticated user can read another workspace's docs (including `content`) by changing the id. POST/PATCH in the same file already check membership; the two GETs do not. **Fix:** gate both GETs with `requireWorkspaceMember(db)` (as `analytics.ts` / `agents.ts` GET do), or replicate the inline membership lookup the POST/PATCH handlers use. *(Confirmed by both reviewers.)*

2. **Broken function-level authz on global agents** - `routes/agents.ts` (POST ~57, PATCH ~87, DELETE ~116). Operate on global agents (`workspaceId IS NULL`) gated only by `requireUser`, no admin/ownership check. Any authenticated non-admin can create, rewrite (including the `personality` that becomes a system prompt), or delete shared agent definitions used across workspaces - prompt poisoning or DoS. **Fix:** require `role === 'admin'` (as `invites.ts` does) for global-agent create/update/delete, or scope these mutations behind `requireWorkspaceMember`.

### MEDIUM

3. **Cross-workspace agent-memory access** - `routes/devices.ts` (PUT/GET `/devices/me/memory/:taskId`, ~313-396). A device's `agentId` (often a shared built-in role like `architect`) plus the task's `workspaceId` is the partition key, but the handler never checks the device's owner is a member of that task's workspace. A device on a shared role can read/write another workspace's agent memory. **Fix:** verify the authenticated device's owning user is a member of `task.workspaceId` before touching `agentMemory`; do not treat a shared `agentId` as an authorization boundary.

4. **Waker endpoint fails open + non-constant-time token compare** - `routes/waker.ts` (~22-28). (a) When `wakerToken` is unset the endpoint is unauthenticated by design (config omission silently makes it public). (b) Token check is an ordinary string compare, a timing side channel. **Fix:** fail closed (refuse to register/boot in production when the token is unset); compare with `crypto.timingSafeEqual` over equal-length buffers.

5. **Session cookie `Secure` defaults off, with a Zod coercion footgun** - `config.ts:11` (`cookieSecure: z.coerce.boolean().default(false)`), applied at `routes/auth.ts:93` and `routes/invites.ts:196`. Cookie is `httpOnly`+`sameSite:lax` (good) but `secure` defaults off, so a plaintext-HTTP hop leaks the session token (note `trustProxy: true`). Worse, `z.coerce.boolean()` makes `"false"`/`"0"` coerce to `true`, so an operator cannot actually disable it as documented. **Fix:** default `cookieSecure` to true (force true in production); parse the env var explicitly (accept only `'1'`/`'true'`) instead of `z.coerce.boolean()`.

### LOW

6. **Login user-enumeration timing oracle + verbose validation errors** - `routes/auth.ts` (~68-83), plus raw `error.issues` echoed by the global handler and several routes. Unknown email returns immediately; known email runs a full bcrypt compare - a timing delta that discloses which emails have accounts (both return `invalid_credentials`). **Fix:** run a dummy `bcrypt.compare` against a fixed hash on the user-not-found path so both branches cost the same; return generic `invalid_input` without the full `issues` array (log issues server-side only).

Positive notes from the review: DB access is parameterized (Drizzle) throughout, no command-injection/SSRF sinks, passwords are bcrypt, session/device tokens are 32-byte random stored as SHA-256 hashes, invite acceptance is race-safe, body size is capped, and production refuses an in-memory DB.
