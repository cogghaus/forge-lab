// PM2 ecosystem config for forge-lab multi-daemon setup.
// Each app entry maps to one logical agent type. Every daemon is the same
// forge-daemon binary; behavior is controlled entirely by environment variables.
//
// Usage:
//   pm2 start ecosystem.config.cjs          # start all daemons
//   pm2 stop ecosystem.config.cjs           # stop all daemons
//   pm2 restart ecosystem.config.cjs        # rolling restart
//   pm2 delete ecosystem.config.cjs         # remove all from PM2 process list
//   pm2 logs forge-fm                       # tail logs for one daemon
//
// Before starting: copy the relevant .env.example.<agent> file to .env.<agent>
// and fill in FORGE_DAEMON_DEVICE_TOKEN and FORGE_DAEMON_WORKSPACE_ID.
// See docs/runbooks/multi-daemon-setup.md for full instructions.

'use strict';

const DAEMON_BIN = './packages/forge-daemon/dist/bin/forge-daemon.js';

// Shared defaults applied to every daemon.
const COMMON_ENV = {
  FORGE_DAEMON_HUB_URL: 'http://localhost:3001',
  FORGE_DAEMON_WORKDIR: './forge-workdir',
  FORGE_DAEMON_DEFAULT_RUNTIME: 'background',
  FORGE_DAEMON_SKIP_PERMISSIONS: 'true',
};

// Shared defaults for worker daemons only (not the FM orchestrator).
const WORKER_ENV = {
  ...COMMON_ENV,
  FORGE_DAEMON_MAX_CONCURRENT_TASKS: '1',
};

/** @type {import('pm2').StartOptions[]} */
const apps = [
  // ─── FM Orchestrator ──────────────────────────────────────────────────────
  // Runs in dispatcher mode: no task spawning, only FM triage.
  // Reads pending_dispatcher_action tasks, spawns FM agent, exits.
  {
    name: 'forge-fm',
    script: DAEMON_BIN,
    env_file: '.env.fm',
    env: {
      ...COMMON_ENV,
      FORGE_DAEMON_AGENT_ID: 'forge-master',
      FORGE_DAEMON_DISPATCHER_MODE: 'true',
      FORGE_DAEMON_STALE_TTL_MINUTES: '30',
      // Orchestrator does not claim worker tasks. MAX_CONCURRENT_TASKS is
      // intentionally absent so the daemon treats it as unlimited (undefined).
    },
    max_memory_restart: '512M',
    restart_delay: 5000,
  },

  // ─── Worker daemons ───────────────────────────────────────────────────────

  {
    name: 'forge-architect',
    script: DAEMON_BIN,
    env_file: '.env.architect',
    env: {
      ...WORKER_ENV,
      FORGE_DAEMON_AGENT_ID: 'architect',
    },
    max_memory_restart: '512M',
    restart_delay: 5000,
  },

  {
    name: 'forge-furnace',
    script: DAEMON_BIN,
    env_file: '.env.furnace',
    env: {
      ...WORKER_ENV,
      FORGE_DAEMON_AGENT_ID: 'furnace',
    },
    max_memory_restart: '512M',
    restart_delay: 5000,
  },

  {
    name: 'forge-anvil',
    script: DAEMON_BIN,
    env_file: '.env.anvil',
    env: {
      ...WORKER_ENV,
      FORGE_DAEMON_AGENT_ID: 'anvil',
    },
    max_memory_restart: '512M',
    restart_delay: 5000,
  },

  {
    name: 'forge-crucible',
    script: DAEMON_BIN,
    env_file: '.env.crucible',
    env: {
      ...WORKER_ENV,
      FORGE_DAEMON_AGENT_ID: 'crucible',
    },
    max_memory_restart: '512M',
    restart_delay: 5000,
  },

  {
    name: 'forge-oracle',
    script: DAEMON_BIN,
    env_file: '.env.oracle',
    env: {
      ...WORKER_ENV,
      FORGE_DAEMON_AGENT_ID: 'oracle',
    },
    max_memory_restart: '512M',
    restart_delay: 5000,
  },

  // Scribe: reactive completion listener + doc curator.
  // listenCompletions (Phase 4) is not yet wired; reserved for that cycle.
  {
    name: 'forge-scribe',
    script: DAEMON_BIN,
    env_file: '.env.scribe',
    env: {
      ...WORKER_ENV,
      FORGE_DAEMON_AGENT_ID: 'scribe',
    },
    max_memory_restart: '512M',
    restart_delay: 5000,
  },
];

module.exports = { apps };
