/**
 * Shared stdio MCP children (electinfo/craft-agents#97)
 *
 * Without this, every session's McpClientPool spawns its own copy of every
 * stdio source: ~0.5 GiB of MCP children per live session. With
 * CRAFT_SHARED_MCP=1, stdio sources are instead served by one child per
 * workspace + source + config, refcounted across sessions.
 *
 * Only the process is shared. Each session keeps its own McpClientPool (proxy
 * tool map, tool cache, sessionPath for large results, summarize callback);
 * the pool just holds a lease instead of a private CraftMcpClient.
 *
 * Lifecycle:
 * - acquire() bumps the entry's refcount (spawning lazily on first use).
 * - lease.close() is idempotent and drops one ref. At zero refs the entry
 *   lingers for CRAFT_SHARED_MCP_LINGER_MS (so a runtime restart reuses the
 *   child), then is unmapped synchronously and its child closed.
 * - A child that exits is dropped; the next call from any lease respawns it
 *   (single in-flight connect, lazy so a crash loop cannot spin).
 * - A new config for the same workspace + slug (credential rotation, edited
 *   config.json) hashes to a new entry, so it gets a new child. Each session
 *   moves over when its source reload sees the changed config
 *   (mcpConfigChanged), and the old child is reaped with its last lease.
 *   Leases never switch children by themselves: that could close a child
 *   under the session's own in-flight call, or follow a config that failed.
 *
 * Env knobs (read at use time, no rebuild needed):
 *   CRAFT_SHARED_MCP=1                 enable sharing
 *   CRAFT_SHARED_MCP_EXCLUDE=a,b       slugs that keep a per-session child
 *   CRAFT_SHARED_MCP_LINGER_MS=30000   idle grace before reaping
 */

import { createHash } from 'node:crypto';
import type { ListPromptsResult, ListResourcesResult, ListResourceTemplatesResult, ReadResourceResult, GetPromptResult, ServerCapabilities, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CraftMcpClient,
  type PoolCallToolOptions,
  type PoolClient,
  type PoolRequestOptions,
  type StdioMcpClientConfig,
} from './client.ts';

const DEFAULT_LINGER_MS = 30_000;

/**
 * Inherited env that must not reach a shared child: SessionManager sets
 * CRAFT_SESSION_DIR globally per session, so a shared child would otherwise
 * see whichever session happened to start last.
 */
const SHARED_OMIT_ENV = ['CRAFT_SESSION_DIR'];

/** True when stdio source `slug` should use a shared child. */
export function isSharedStdioEnabled(slug: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CRAFT_SHARED_MCP !== '1') return false;
  const excluded = (env.CRAFT_SHARED_MCP_EXCLUDE ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return !excluded.includes(slug);
}

function lingerMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CRAFT_SHARED_MCP_LINGER_MS;
  if (raw === undefined || raw === '') return DEFAULT_LINGER_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LINGER_MS;
}

/** Stable hash of what the child is spawned with (credentials included, never logged). */
export function stdioConfigHash(config: Pick<StdioMcpClientConfig, 'command' | 'args' | 'env'>): string {
  const env = Object.entries(config.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify([config.command, config.args ?? [], env]))
    .digest('hex')
    .slice(0, 16);
}

/** The subset of CraftMcpClient the registry drives (injectable for tests). */
export interface SharedChild extends PoolClient {
  connect(): Promise<void>;
  getPid?(): number | null;
}

export type SharedChildFactory = (config: StdioMcpClientConfig, onClose: () => void) => SharedChild;

const defaultFactory: SharedChildFactory = (config, onClose) =>
  new CraftMcpClient(config, { onClose, omitEnv: SHARED_OMIT_ENV });

interface Entry {
  key: string;
  slug: string;
  config: StdioMcpClientConfig;
  child: SharedChild | null;
  connecting: Promise<SharedChild> | null;
  refs: number;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  spawns: number;
  /** Last known handshake data, kept across a crash so feature checks still pass before respawn */
  capabilities?: ServerCapabilities;
  instructions?: string;
}

export interface SharedStdioEntryStats {
  slug: string;
  hash: string;
  refs: number;
  pid: number | null;
  spawns: number;
  lingering: boolean;
}

export class SharedStdioMcpRegistry {
  private entries = new Map<string, Entry>();
  private factory: SharedChildFactory;
  private lingerMs: () => number;
  private log: (msg: string) => void;
  private announced = false;

  constructor(options?: { factory?: SharedChildFactory; lingerMs?: () => number; log?: (msg: string) => void }) {
    this.factory = options?.factory ?? defaultFactory;
    this.lingerMs = options?.lingerMs ?? (() => lingerMsFromEnv());
    this.log = options?.log ?? ((msg) => console.info(`[SharedStdioMcp] ${msg}`));
  }

  /** Take a reference on the shared child for this workspace + source + config. */
  acquire(workspaceRootPath: string, slug: string, config: StdioMcpClientConfig): SharedStdioLease {
    if (!this.announced) {
      this.announced = true;
      this.log(`Shared stdio MCP on: linger=${this.lingerMs()}ms, exclude=[${process.env.CRAFT_SHARED_MCP_EXCLUDE ?? ''}]`);
    }
    const entry = this.retain(workspaceRootPath, slug, config);
    return new SharedStdioLease(this, entry);
  }

  /** Snapshot for diagnostics and the smoke test. */
  stats(): SharedStdioEntryStats[] {
    return [...this.entries.values()].map(e => ({
      slug: e.slug,
      hash: e.key.slice(e.key.lastIndexOf('#') + 1),
      refs: e.refs,
      pid: e.child?.getPid?.() ?? null,
      spawns: e.spawns,
      lingering: e.lingerTimer !== null,
    }));
  }

  /** @internal */
  retain(workspaceRootPath: string, slug: string, config: StdioMcpClientConfig): Entry {
    const key = `${workspaceRootPath}\u0000${slug}#${stdioConfigHash(config)}`;
    let entry = this.entries.get(key);
    if (entry) {
      if (entry.lingerTimer) {
        clearTimeout(entry.lingerTimer);
        entry.lingerTimer = null;
      }
    } else {
      entry = {
        key, slug, config,
        child: null, connecting: null, refs: 0, lingerTimer: null,
        closed: false, spawns: 0,
      };
      this.entries.set(key, entry);
    }
    entry.refs++;
    return entry;
  }

  /** @internal Drop one ref; reap after the linger grace when none remain. */
  release(entry: Entry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.closed) return;
    const linger = this.lingerMs();
    if (linger <= 0) {
      void this.closeEntry(entry);
      return;
    }
    if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
    entry.lingerTimer = setTimeout(() => {
      entry.lingerTimer = null;
      void this.closeEntry(entry);
    }, linger);
    entry.lingerTimer.unref?.();
  }

  /** @internal A connected child for the entry, spawning one if needed. */
  async ensureChild(entry: Entry): Promise<SharedChild> {
    if (entry.closed) throw new Error(`Shared MCP child for "${entry.slug}" was released`);
    if (entry.child) return entry.child;
    if (entry.connecting) return entry.connecting;

    const connecting = (async () => {
      let child: SharedChild | null = null;
      child = this.factory(entry.config, () => {
        // The child exited (crash, kill, or our own close): drop it so the
        // next call from any lease spawns a fresh one.
        if (entry.child === child) {
          entry.child = null;
          if (!entry.closed) this.log(`${entry.slug}: child exited, will respawn on next use (refs=${entry.refs})`);
        }
      });
      try {
        await child.connect();
      } catch (error) {
        await child.close().catch(() => {});
        throw error;
      }
      if (entry.closed) {
        // Reaped while we were connecting: do not leave an orphan child.
        await child.close().catch(() => {});
        throw new Error(`Shared MCP child for "${entry.slug}" was released`);
      }
      entry.child = child;
      entry.spawns++;
      entry.capabilities = child.getServerCapabilities?.();
      entry.instructions = child.getInstructions?.();
      this.log(`${entry.slug}: spawned shared child pid=${child.getPid?.() ?? '?'} (refs=${entry.refs}, spawns=${entry.spawns})`);
      return child;
    })();
    entry.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (entry.connecting === connecting) entry.connecting = null;
    }
  }

  /** Unmap synchronously (so a racing acquire gets a fresh entry), then close the child. */
  private async closeEntry(entry: Entry): Promise<void> {
    if (entry.closed || entry.refs > 0) return;
    entry.closed = true;
    if (entry.lingerTimer) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const child = entry.child;
    entry.child = null;
    const pid = child?.getPid?.() ?? null;
    await entry.connecting?.catch(() => {});
    if (child) {
      await child.close().catch(() => {});
      this.log(`${entry.slug}: reaped shared child pid=${pid ?? '?'}`);
    }
  }

  /** Close everything (tests, shutdown). */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    for (const e of all) e.refs = 0;
    await Promise.all(all.map(e => this.closeEntry(e)));
  }
}

/**
 * One session's reference to a shared child. Implements PoolClient so
 * McpClientPool treats it like a private client.
 */
export class SharedStdioLease implements PoolClient {
  private released = false;

  constructor(private registry: SharedStdioMcpRegistry, private readonly entry: Entry) {}

  private async child(): Promise<SharedChild> {
    if (this.released) throw new Error(`MCP source "${this.entry.slug}" lease was released`);
    return this.registry.ensureChild(this.entry);
  }

  async connect(): Promise<void> {
    await this.child();
  }

  async listTools(): Promise<Tool[]> {
    return (await this.child()).listTools();
  }

  async callTool(name: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<unknown> {
    return (await this.child()).callTool(name, args, options);
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return this.entry.child?.getServerCapabilities?.() ?? this.entry.capabilities;
  }

  getInstructions(): string | undefined {
    return this.entry.child?.getInstructions?.() ?? this.entry.instructions;
  }

  async listResources(cursor?: string, options?: PoolRequestOptions): Promise<ListResourcesResult> {
    return (await this.child()).listResources!(cursor, options);
  }

  async listResourceTemplates(cursor?: string, options?: PoolRequestOptions): Promise<ListResourceTemplatesResult> {
    return (await this.child()).listResourceTemplates!(cursor, options);
  }

  async readResource(uri: string, options?: PoolRequestOptions): Promise<ReadResourceResult> {
    return (await this.child()).readResource!(uri, options);
  }

  async listPrompts(cursor?: string, options?: PoolRequestOptions): Promise<ListPromptsResult> {
    return (await this.child()).listPrompts!(cursor, options);
  }

  async getPrompt(name: string, args?: Record<string, string>, options?: PoolRequestOptions): Promise<GetPromptResult> {
    return (await this.child()).getPrompt!(name, args, options);
  }

  getPid(): number | null {
    return this.entry.child?.getPid?.() ?? null;
  }

  /** Idempotent: drops this session's reference. The child lives on while others hold it. */
  async close(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.registry.release(this.entry);
  }
}

/** Process-wide registry used by McpClientPool. */
export const sharedStdioMcp = new SharedStdioMcpRegistry();
