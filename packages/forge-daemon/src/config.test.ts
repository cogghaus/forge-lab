import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

const REQUIRED = {
  FORGE_DAEMON_HUB_URL: 'http://localhost:3000',
  FORGE_DAEMON_DEVICE_TOKEN: 'tok-abc',
};

describe('loadConfig', () => {
  it('parses required fields', () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.hubUrl).toBe('http://localhost:3000');
    expect(cfg.deviceToken).toBe('tok-abc');
  });

  it('defaultRuntimeId defaults to background', () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.defaultRuntimeId).toBe('background');
  });

  it('defaultAgentId defaults to architect', () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.defaultAgentId).toBe('architect');
  });

  it('FORGE_DAEMON_AGENT_ID overrides defaultAgentId', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_AGENT_ID: 'crucible' });
    expect(cfg.defaultAgentId).toBe('crucible');
  });

  it('skipPermissions defaults to true', () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.skipPermissions).toBe(true);
  });

  it('FORGE_DAEMON_SKIP_PERMISSIONS=false disables skip', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_SKIP_PERMISSIONS: 'false' });
    expect(cfg.skipPermissions).toBe(false);
  });

  it('FORGE_DAEMON_SKIP_PERMISSIONS=0 disables skip', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_SKIP_PERMISSIONS: '0' });
    expect(cfg.skipPermissions).toBe(false);
  });

  it('FORGE_DAEMON_SKIP_PERMISSIONS="" (empty string) treats as unset — defaults to true', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_SKIP_PERMISSIONS: '' });
    expect(cfg.skipPermissions).toBe(true);
  });

  it('workspaceId is undefined when not set', () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.workspaceId).toBeUndefined();
  });

  it('FORGE_DAEMON_WORKSPACE_ID sets workspaceId', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_WORKSPACE_ID: 'ws-123' });
    expect(cfg.workspaceId).toBe('ws-123');
  });

  it('dispatcherMode defaults to false', () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.dispatcherMode).toBe(false);
  });

  it('FORGE_DAEMON_DISPATCHER_MODE=true enables dispatcher mode', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_DISPATCHER_MODE: 'true' });
    expect(cfg.dispatcherMode).toBe(true);
  });

  it('FORGE_DAEMON_DISPATCHER_MODE=false keeps dispatcher mode off', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_DISPATCHER_MODE: 'false' });
    expect(cfg.dispatcherMode).toBe(false);
  });

  it('FORGE_DAEMON_DISPATCHER_MODE="" (empty) treats as unset — defaults to false', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_DISPATCHER_MODE: '' });
    expect(cfg.dispatcherMode).toBe(false);
  });

  it('staleTtlMinutes is undefined when not set', () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.staleTtlMinutes).toBeUndefined();
  });

  it('FORGE_DAEMON_STALE_TTL_MINUTES sets staleTtlMinutes', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_STALE_TTL_MINUTES: '45' });
    expect(cfg.staleTtlMinutes).toBe(45);
  });

  it('maxConcurrentTasks is undefined when not set', () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.maxConcurrentTasks).toBeUndefined();
  });

  it('FORGE_DAEMON_MAX_CONCURRENT_TASKS sets maxConcurrentTasks', () => {
    const cfg = loadConfig({ ...REQUIRED, FORGE_DAEMON_MAX_CONCURRENT_TASKS: '3' });
    expect(cfg.maxConcurrentTasks).toBe(3);
  });

  it('FORGE_DAEMON_MAX_CONCURRENT_TASKS=0 throws (min 1)', () => {
    expect(() => loadConfig({ ...REQUIRED, FORGE_DAEMON_MAX_CONCURRENT_TASKS: '0' })).toThrow();
  });

  it('throws on missing required fields', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('throws on invalid hub URL', () => {
    expect(() => loadConfig({ FORGE_DAEMON_HUB_URL: 'not-a-url', FORGE_DAEMON_DEVICE_TOKEN: 'tok' })).toThrow();
  });
});
