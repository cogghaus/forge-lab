/**
 * forge-waker: polls the hub for pending work and starts the appropriate
 * daemon containers via the Docker API. Uses dockerode (no CLI dependency).
 *
 * Runs 24/7 as a lightweight always-on service (restart: always).
 * Daemon containers use restart: on-failure so they only restart on crashes,
 * not on clean idle-shutdown exits. The waker is the re-start mechanism for
 * idle daemons.
 */
import Dockerode from 'dockerode';

const HUB_URL = process.env['HUB_URL'] ?? 'http://forge-hub:3000';
const WAKER_TOKEN = process.env['WAKER_TOKEN'] ?? '';
const POLL_INTERVAL_MS = parseInt(process.env['POLL_INTERVAL_MS'] ?? '60000', 10);

// Maps agent role names (from assigned_agent_id in tasks) to container names.
const ROLE_TO_CONTAINER = {
  'forge-master': 'forge-fm',
  'architect': 'forge-architect',
  'furnace': 'forge-furnace',
  'anvil': 'forge-anvil',
  'crucible': 'forge-crucible',
  'oracle': 'forge-oracle',
  'scribe': 'forge-scribe',
  'herald': 'forge-herald',
  'temper': 'forge-temper',
};

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

async function startContainer(name) {
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
      console.log(`[waker] started ${name}`);
    }
  } catch (err) {
    if (err.statusCode !== 404) {
      console.error(`[waker] failed to start ${name}: ${err.message}`);
    }
  }
}

async function poll() {
  try {
    const res = await fetch(`${HUB_URL}/waker/has-work`, {
      headers: WAKER_TOKEN ? { Authorization: `Bearer ${WAKER_TOKEN}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[waker] has-work returned ${res.status}`);
      return;
    }
    const { pending, byRole } = await res.json();
    if (pending === 0) return;

    console.log(`[waker] ${pending} pending task(s), starting containers`);

    const toStart = new Set();
    for (const [role, count] of Object.entries(byRole)) {
      if (count > 0) {
        const containerName = ROLE_TO_CONTAINER[role];
        if (containerName) {
          toStart.add(containerName);
        } else {
          // Unknown role — start FM to route it
          toStart.add('forge-fm');
        }
      }
    }

    // FM is always started when workers need to be started, so it can
    // dispatch any assigned tasks to workers that weren't yet aware.
    if (toStart.size > 0 && !toStart.has('forge-fm')) {
      toStart.add('forge-fm');
    }

    await Promise.all([...toStart].map(startContainer));
  } catch (err) {
    console.error(`[waker] poll error: ${err.message}`);
  }
}

console.log(`[waker] polling ${HUB_URL} every ${POLL_INTERVAL_MS}ms`);
await poll();
setInterval(poll, POLL_INTERVAL_MS);
