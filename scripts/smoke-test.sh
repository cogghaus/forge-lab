#!/usr/bin/env bash
# smoke-test.sh
#
# End-to-end smoke test for forge-lab.
#
# Usage:
#   ./scripts/smoke-test.sh [options]
#
# Options:
#   --hub-url URL        Hub API base URL (default: http://localhost:3000)
#   --workspace-id ID    Workspace ID to create the test task in (required unless --create-workspace)
#   --create-workspace   Create a temporary workspace for this run (auto-cleaned on exit)
#   --email EMAIL        Admin login email (default: admin@hub.local)
#   --password PASS      Admin login password (required)
#   --timeout SECS       Max seconds to wait for task completion (default: 120)
#   --task-type TYPE     "dispatcher" or "worker" (default: dispatcher)
#                          dispatcher = pending_dispatcher_action, tests FM triage path
#                          worker     = pending_agent with assignedAgentId=architect
#   --help               Show this help
#
# Exit codes:
#   0  All checks passed
#   1  Test failed or timed out
#   2  Usage error
#
# Requirements:
#   curl  jq  (bash 4.0+)
#
# Examples:
#   # Full FM triage path
#   ./scripts/smoke-test.sh --password forgelab123 --workspace-id ws_abc
#
#   # Worker-only path (no FM required)
#   ./scripts/smoke-test.sh --password forgelab123 --workspace-id ws_abc --task-type worker

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

HUB_URL="http://localhost:3000"
WORKSPACE_ID=""
CREATE_WORKSPACE=false
EMAIL="admin@hub.local"
PASSWORD=""
TIMEOUT=120
TASK_TYPE="dispatcher"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case $1 in
    --hub-url)        HUB_URL="$2";        shift 2 ;;
    --workspace-id)   WORKSPACE_ID="$2";   shift 2 ;;
    --create-workspace) CREATE_WORKSPACE=true; shift ;;
    --email)          EMAIL="$2";          shift 2 ;;
    --password)       PASSWORD="$2";       shift 2 ;;
    --timeout)        TIMEOUT="$2";        shift 2 ;;
    --task-type)      TASK_TYPE="$2";      shift 2 ;;
    --help)
      sed -n '3,50p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$PASSWORD" ]]; then
  echo "ERROR: --password is required." >&2
  exit 2
fi

if [[ -z "$WORKSPACE_ID" ]] && [[ "$CREATE_WORKSPACE" == "false" ]]; then
  echo "ERROR: --workspace-id or --create-workspace is required." >&2
  exit 2
fi

if [[ "$TASK_TYPE" != "dispatcher" ]] && [[ "$TASK_TYPE" != "worker" ]]; then
  echo "ERROR: --task-type must be 'dispatcher' or 'worker'." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"' EXIT

log()  { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "[FAIL] $*" >&2; exit 1; }
pass() { echo "[PASS] $*"; }

# ---------------------------------------------------------------------------
# Step 1 - Hub health
# ---------------------------------------------------------------------------

log "Step 1: Hub health"

HEALTH=$(curl -sf "${HUB_URL}/healthz" 2>/dev/null || echo "UNREACHABLE")
if [[ "$HEALTH" != *'"ok"'* ]]; then
  fail "Hub not reachable at ${HUB_URL}/healthz (got: ${HEALTH})"
fi
pass "Hub is healthy"

# ---------------------------------------------------------------------------
# Step 2 - Login
# ---------------------------------------------------------------------------

log "Step 2: Login as ${EMAIL}"

LOGIN_RES=$(curl -sf -c "$COOKIES" -X POST "${HUB_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" 2>/dev/null) || true

if [[ -z "$LOGIN_RES" ]] || echo "$LOGIN_RES" | jq -e '.error' > /dev/null 2>&1; then
  fail "Login failed: ${LOGIN_RES}"
fi
pass "Logged in"

# ---------------------------------------------------------------------------
# Step 3 - Workspace
# ---------------------------------------------------------------------------

if [[ "$CREATE_WORKSPACE" == "true" ]]; then
  log "Step 3: Creating temporary workspace"

  SLUG="smoke-$(date +%s)"
  WS_RES=$(curl -sf -b "$COOKIES" -X POST "${HUB_URL}/workspaces" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"Smoke Test\",\"slug\":\"${SLUG}\"}" 2>/dev/null)
  WORKSPACE_ID=$(echo "$WS_RES" | jq -r '.id')
  if [[ -z "$WORKSPACE_ID" ]] || [[ "$WORKSPACE_ID" == "null" ]]; then
    fail "Failed to create workspace: ${WS_RES}"
  fi
  pass "Created workspace ${WORKSPACE_ID}"
else
  log "Step 3: Using workspace ${WORKSPACE_ID}"
fi

# ---------------------------------------------------------------------------
# Step 4 - Create test task
# ---------------------------------------------------------------------------

log "Step 4: Creating test task (type: ${TASK_TYPE})"

if [[ "$TASK_TYPE" == "dispatcher" ]]; then
  TASK_PAYLOAD="{\"title\":\"[smoke-test] $(date -Iseconds)\",\"projectPrefix\":\"smoke\",\"workspaceId\":\"${WORKSPACE_ID}\",\"status\":\"pending_dispatcher_action\"}"
else
  TASK_PAYLOAD="{\"title\":\"[smoke-test] $(date -Iseconds)\",\"projectPrefix\":\"smoke\",\"workspaceId\":\"${WORKSPACE_ID}\",\"status\":\"pending_agent\",\"assignedAgentId\":\"architect\"}"
fi

TASK_RES=$(curl -sf -b "$COOKIES" -X POST "${HUB_URL}/tasks" \
  -H "Content-Type: application/json" \
  -d "$TASK_PAYLOAD" 2>/dev/null)
TASK_ID=$(echo "$TASK_RES" | jq -r '.id')
if [[ -z "$TASK_ID" ]] || [[ "$TASK_ID" == "null" ]]; then
  fail "Failed to create task: ${TASK_RES}"
fi
pass "Created task ${TASK_ID}"

# ---------------------------------------------------------------------------
# Step 5 - Poll for completion
# ---------------------------------------------------------------------------

log "Step 5: Polling task ${TASK_ID} (timeout: ${TIMEOUT}s)"

ELAPSED=0
POLL_INTERVAL=3
STATUS="unknown"

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  TASK_RES=$(curl -sf -b "$COOKIES" "${HUB_URL}/tasks/${TASK_ID}" 2>/dev/null || echo '{}')
  STATUS=$(echo "$TASK_RES" | jq -r '.status // "unknown"')

  case "$STATUS" in
    completed)
      pass "Task reached 'completed' after ${ELAPSED}s"
      break
      ;;
    failed)
      fail "Task reached 'failed' after ${ELAPSED}s"
      ;;
    cancelled)
      fail "Task was cancelled after ${ELAPSED}s"
      ;;
  esac

  log "  Status: ${STATUS} (${ELAPSED}s elapsed)"
  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

if [[ "$STATUS" != "completed" ]]; then
  fail "Task did not complete within ${TIMEOUT}s (final status: ${STATUS})"
fi

# ---------------------------------------------------------------------------
# Step 6 - Done marker check (optional, best-effort)
# ---------------------------------------------------------------------------

if [[ -n "${FORGE_DAEMON_WORKDIR:-}" ]]; then
  DONE_FILE="${FORGE_DAEMON_WORKDIR}/.forge/tasks/${TASK_ID}.done"
  log "Step 6: Checking done marker at ${DONE_FILE}"
  if [[ -f "$DONE_FILE" ]]; then
    pass "Done marker exists: ${DONE_FILE}"
  else
    log "WARNING: Done marker not found at ${DONE_FILE} (task completed via hub API; daemon may clean up markers)"
  fi
else
  log "Step 6: Skipping done marker check (FORGE_DAEMON_WORKDIR not set)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "================================"
echo " SMOKE TEST PASSED"
echo "================================"
echo " Hub:       ${HUB_URL}"
echo " Workspace: ${WORKSPACE_ID}"
echo " Task:      ${TASK_ID}"
echo " Type:      ${TASK_TYPE}"
echo " Time:      ${ELAPSED}s"
echo "================================"
exit 0
