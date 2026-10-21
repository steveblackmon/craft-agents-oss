/**
 * Shared stdio MCP children (electinfo/craft-agents#97): one child per
 * workspace + source + config across sessions, refcounted, reaped after the
 * last session leaves, respawned after a crash, and retired on config change.
 * Uses a real stdio fixture whose `pid` tool reports the server's pid.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClientPool } from '../mcp-pool.ts';
import { SharedStdioMcpRegistry, isSharedStdioEnabled, stdioConfigHash } from '../shared-stdio.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-server-pid.mjs');
const WS = '/tmp/ws-shared-stdio-test';
const TOOL = 'mcp__pidsrc__pid';

function stdio(tag = 'a'): SdkMcpServerConfig {
  return { type: 'stdio', command: 'node', args: [FIXTURE], env: { FIXTURE_TAG: tag } };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 20));
  }
}

async function pidOf(pool: McpClientPool): Promise<{ pid: number; sessionDir: string | null; tag: string | null }> {
  const result = await pool.callTool(TOOL, {});
  expect(result.isError).toBe(false);
  return JSON.parse(result.content);
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['CRAFT_SHARED_MCP', 'CRAFT_SHARED_MCP_EXCLUDE', 'CRAFT_LOCAL_MCP_ENABLED', 'CRAFT_SESSION_DIR'];

let registry: SharedStdioMcpRegistry;
let lingerMs = 0;
const pools: McpClientPool[] = [];

function newPool(): McpClientPool {
  const pool = new McpClientPool({ workspaceRootPath: WS, sharedStdio: registry });
  pools.push(pool);
  return pool;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CRAFT_SHARED_MCP = '1';
  process.env.CRAFT_LOCAL_MCP_ENABLED = 'true';
  delete process.env.CRAFT_SHARED_MCP_EXCLUDE;
  lingerMs = 0;
  registry = new SharedStdioMcpRegistry({ lingerMs: () => lingerMs, log: () => {} });
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map(p => p.disconnectAll()));
  await registry.closeAll();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('isSharedStdioEnabled', () => {
  test('requires CRAFT_SHARED_MCP=1 and honors the exclude list', () => {
    expect(isSharedStdioEnabled('x', {})).toBe(false);
    expect(isSharedStdioEnabled('x', { CRAFT_SHARED_MCP: '0' })).toBe(false);
    expect(isSharedStdioEnabled('x', { CRAFT_SHARED_MCP: '1' })).toBe(true);
    expect(isSharedStdioEnabled('x', { CRAFT_SHARED_MCP: '1', CRAFT_SHARED_MCP_EXCLUDE: 'y, x' })).toBe(false);
  });

  test('config hash ignores env order and changes with env values', () => {
    const a = stdioConfigHash({ command: 'c', args: ['1'], env: { A: '1', B: '2' } });
    expect(stdioConfigHash({ command: 'c', args: ['1'], env: { B: '2', A: '1' } })).toBe(a);
    expect(stdioConfigHash({ command: 'c', args: ['1'], env: { A: '1', B: '3' } })).not.toBe(a);
  });
});

describe('shared stdio children', () => {
  test('two sessions on one source share ONE child', async () => {
    const p1 = newPool();
    const p2 = newPool();
    await p1.sync({ pidsrc: stdio() });
    await p2.sync({ pidsrc: stdio() });
    const a = await pidOf(p1);
    const b = await pidOf(p2);
    expect(a.pid).toBe(b.pid);
    expect(registry.stats()).toEqual([expect.objectContaining({ slug: 'pidsrc', refs: 2, spawns: 1, pid: a.pid })]);
  });

  test('flag off: each session spawns its own child', async () => {
    process.env.CRAFT_SHARED_MCP = '0';
    const p1 = newPool();
    const p2 = newPool();
    await p1.sync({ pidsrc: stdio() });
    await p2.sync({ pidsrc: stdio() });
    expect((await pidOf(p1)).pid).not.toBe((await pidOf(p2)).pid);
    expect(registry.stats()).toEqual([]);
  });

  test('excluded slug keeps a per-session child', async () => {
    process.env.CRAFT_SHARED_MCP_EXCLUDE = 'pidsrc';
    const p1 = newPool();
    const p2 = newPool();
    await p1.sync({ pidsrc: stdio() });
    await p2.sync({ pidsrc: stdio() });
    expect((await pidOf(p1)).pid).not.toBe((await pidOf(p2)).pid);
  });

  test('child survives one session leaving and is reaped when the last leaves', async () => {
    const p1 = newPool();
    const p2 = newPool();
    await p1.sync({ pidsrc: stdio() });
    await p2.sync({ pidsrc: stdio() });
    const { pid } = await pidOf(p1);

    await p1.disconnectAll(); // e.g. idle eviction of session 1
    expect(alive(pid)).toBe(true);
    expect((await pidOf(p2)).pid).toBe(pid);
    expect(registry.stats()[0]?.refs).toBe(1);

    await p2.disconnectAll();
    await waitFor(() => !alive(pid));
    expect(registry.stats()).toEqual([]);
  });

  test('disconnectAll twice (eviction racing delete) releases once', async () => {
    const p1 = newPool();
    const p2 = newPool();
    await p1.sync({ pidsrc: stdio() });
    await p2.sync({ pidsrc: stdio() });
    const { pid } = await pidOf(p2);
    await Promise.all([p1.disconnectAll(), p1.disconnectAll()]);
    expect(registry.stats()[0]?.refs).toBe(1);
    expect(alive(pid)).toBe(true);
  });

  test('linger: a session returning during the grace reuses the child', async () => {
    lingerMs = 5_000;
    const p1 = newPool();
    await p1.sync({ pidsrc: stdio() });
    const { pid } = await pidOf(p1);
    await p1.disconnectAll();
    expect(registry.stats()[0]).toEqual(expect.objectContaining({ refs: 0, lingering: true }));
    expect(alive(pid)).toBe(true);

    const p2 = newPool();
    await p2.sync({ pidsrc: stdio() });
    expect((await pidOf(p2)).pid).toBe(pid);
    expect(registry.stats()[0]).toEqual(expect.objectContaining({ refs: 1, lingering: false, spawns: 1 }));
  });

  test('linger expiry reaps the child', async () => {
    lingerMs = 100;
    const p1 = newPool();
    await p1.sync({ pidsrc: stdio() });
    const { pid } = await pidOf(p1);
    await p1.disconnectAll();
    expect(alive(pid)).toBe(true);
    await waitFor(() => !alive(pid));
    expect(registry.stats()).toEqual([]);
  });

  test('a crashed child respawns once for all sessions', async () => {
    const p1 = newPool();
    const p2 = newPool();
    await p1.sync({ pidsrc: stdio() });
    await p2.sync({ pidsrc: stdio() });
    const { pid } = await pidOf(p1);

    process.kill(pid, 'SIGKILL');
    await waitFor(() => registry.stats()[0]?.pid === null);

    const [a, b] = await Promise.all([pidOf(p1), pidOf(p2)]);
    expect(a.pid).not.toBe(pid);
    expect(a.pid).toBe(b.pid);
    expect(registry.stats()[0]).toEqual(expect.objectContaining({ refs: 2, spawns: 2 }));
  });

  test('config change: each session moves to the new child on its own reload; old child reaped with its last lease', async () => {
    const p1 = newPool();
    const p2 = newPool();
    await p1.sync({ pidsrc: stdio('a') });
    await p2.sync({ pidsrc: stdio('a') });
    const old = await pidOf(p1);
    expect(old.tag).toBe('a');

    // Session 1 reloads sources after a credential rotation in config.json
    await p1.sync({ pidsrc: stdio('b') });
    const fresh = await pidOf(p1);
    expect(fresh.tag).toBe('b');
    expect(fresh.pid).not.toBe(old.pid);

    // Session 2 has not reloaded yet (e.g. mid-turn): it keeps its child, untouched
    expect(await pidOf(p2)).toEqual(old);
    expect(alive(old.pid)).toBe(true);

    // Its reload moves it over and the old child goes with its last lease
    await p2.sync({ pidsrc: stdio('b') });
    expect((await pidOf(p2)).pid).toBe(fresh.pid);
    await waitFor(() => !alive(old.pid));
    expect(registry.stats()).toEqual([expect.objectContaining({ refs: 2, pid: fresh.pid })]);
  });

  test('config change in another session does not interrupt an in-flight call', async () => {
    const p1 = newPool();
    const p2 = newPool();
    await p1.sync({ pidsrc: stdio('a') });
    await p2.sync({ pidsrc: stdio('a') });
    const inFlight = pidOf(p1);
    await p2.sync({ pidsrc: stdio('b') });
    const [a, again] = await Promise.all([inFlight, pidOf(p1)]);
    expect(a.tag).toBe('a');
    expect(again.pid).toBe(a.pid);
  });

  test('capabilities survive a crash, so feature checks pass before the respawn', async () => {
    const p1 = newPool();
    await p1.sync({ pidsrc: stdio() });
    const lease = registry.acquire(WS, 'pidsrc', { transport: 'stdio', command: 'node', args: [FIXTURE], env: { FIXTURE_TAG: 'a' } });
    expect(lease.getServerCapabilities()).toEqual(expect.objectContaining({ tools: {} }));
    const { pid } = await pidOf(p1);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => registry.stats()[0]?.pid === null);
    expect(lease.getServerCapabilities()).toEqual(expect.objectContaining({ tools: {} }));
    await lease.close();
  });

  test('disposed mid-connect: the connect releases its lease (no leaked child)', async () => {
    const p1 = newPool();
    const connecting = p1.sync({ pidsrc: stdio() });
    await p1.disconnectAll(); // eviction while the child is still starting
    expect(await connecting).toEqual(['pidsrc']);
    expect(p1.isConnected('pidsrc')).toBe(false);
    await waitFor(() => registry.stats().length === 0);
  });

  test('failed spawn releases the lease', async () => {
    const p1 = newPool();
    const failures = await p1.sync({ broken: { type: 'stdio', command: '/nonexistent/mcp-server-xyz' } });
    expect(failures).toEqual(['broken']);
    expect(registry.stats()).toEqual([]);
  });

  test('shared child does not inherit a session-specific CRAFT_SESSION_DIR', async () => {
    process.env.CRAFT_SESSION_DIR = '/tmp/some-session';
    const p1 = newPool();
    await p1.sync({ pidsrc: stdio() });
    expect((await pidOf(p1)).sessionDir).toBeNull();
  });

  test('different workspaces do not share', async () => {
    const p1 = newPool();
    const p2 = new McpClientPool({ workspaceRootPath: '/tmp/ws-other', sharedStdio: registry });
    pools.push(p2);
    await p1.sync({ pidsrc: stdio() });
    await p2.sync({ pidsrc: stdio() });
    expect((await pidOf(p1)).pid).not.toBe((await pidOf(p2)).pid);
  });
});
