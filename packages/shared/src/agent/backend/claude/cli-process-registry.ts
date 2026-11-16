/**
 * Registry of every Claude Code CLI subprocess the SDK spawns for us, so none
 * can outlive the agent that started it (storeminder-ai/craft-agents#250).
 *
 * Background: a long-lived server accumulated Claude CLIs that no runtime owned
 * any more (75 live, 64 older than 17h, while the idle reaper tracked 3). Each one
 * survives every later reap because teardown only reaches the query the agent
 * currently references. Whatever path drops a query reference without closing it,
 * the registry still knows the pid and its owner, so teardown and the reaper's
 * backstop can end it.
 *
 * Pids come from the SDK's `onProcessSpawned` hook on its default local spawn,
 * which keeps the SDK's own stdio/stderr handling intact. A pid is only ever
 * signalled while `/proc/<pid>/stat` still reports the start time recorded at
 * registration, so a reused pid is never touched. Where that identity cannot be
 * read (non-Linux hosts) nothing is tracked and nothing is killed.
 */

import { readFileSync } from 'fs'

export type CliKind = 'persistent' | 'oneshot'

export interface CliRegistration {
  pid: number
  /** Unique per agent instance (not per session: a session may own several agents over time). */
  ownerId: string
  sessionId?: string
  kind: CliKind
  /** Persistent-query generation of the owner when this CLI was spawned. */
  generation: number
  /** Kernel start time (clock ticks since boot): the process identity. */
  startTime: string
  registeredAt: number
}

export interface CliProcessRegistryDeps {
  readStartTime: (pid: number) => string | null
  kill: (pid: number, signal: NodeJS.Signals) => void
  now: () => number
  setTimer: (fn: () => void, ms: number) => void
}

/** Field 22 (starttime) of /proc/<pid>/stat; null when the process is gone or /proc is unavailable. */
export function readProcStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm (field 2) may contain spaces and parens: fields after the LAST ')' start at field 3.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return rest[22 - 3] ?? null
  } catch {
    return null
  }
}

const defaultDeps: CliProcessRegistryDeps = {
  readStartTime: readProcStartTime,
  kill: (pid, signal) => { process.kill(pid, signal) },
  now: () => Date.now(),
  setTimer: (fn, ms) => { setTimeout(fn, ms).unref?.() },
}

/** Grace for the SDK's own close path (stdin EOF + ~2s, then its kill) before we step in. */
export const CLI_TEARDOWN_GRACE_MS = 5_000
/** After SIGTERM, how long a CLI gets to exit before SIGKILL. */
export const CLI_SIGKILL_GRACE_MS = 3_000
/** The reaper backstop leaves a CLI younger than this alone (its owner may still be wiring up). */
export const CLI_ORPHAN_MIN_AGE_MS = 15 * 60_000

export interface CliSweepResult {
  tracked: number
  terminated: CliRegistration[]
}

export class CliProcessRegistry {
  private readonly entries = new Map<number, CliRegistration>()
  /** Owners whose agent was destroyed: everything they still own is fair game. */
  private readonly retiredOwners = new Set<string>()
  /** Each owner's current persistent-query generation: older persistent CLIs are stale. */
  private readonly ownerGenerations = new Map<string, number>()
  /** Pids with a termination already scheduled. */
  private readonly terminating = new Set<number>()

  constructor(private readonly deps: CliProcessRegistryDeps = defaultDeps) {}

  /** Record a freshly spawned CLI. Returns false (untracked) when its identity can't be read. */
  register(pid: number, info: Omit<CliRegistration, 'pid' | 'startTime' | 'registeredAt'>): boolean {
    const startTime = this.deps.readStartTime(pid)
    if (startTime === null) return false
    this.entries.set(pid, { ...info, pid, startTime, registeredAt: this.deps.now() })
    return true
  }

  setOwnerGeneration(ownerId: string, generation: number): void {
    this.ownerGenerations.set(ownerId, generation)
  }

  /** The owner's agent is gone; any CLI it still has is an orphan. */
  retireOwner(ownerId: string): void {
    this.retiredOwners.add(ownerId)
    this.ownerGenerations.delete(ownerId)
  }

  /** Same pid AND same start time: the process we registered is still running. */
  isAlive(entry: CliRegistration): boolean {
    return this.deps.readStartTime(entry.pid) === entry.startTime
  }

  /** Live registrations; dead ones are dropped. */
  list(): CliRegistration[] {
    this.prune()
    return [...this.entries.values()]
  }

  /**
   * Terminate a registered CLI after `delayMs` if it is still running then: SIGTERM, and SIGKILL
   * `CLI_SIGKILL_GRACE_MS` later if it still has not exited. The identity is re-checked before
   * every signal. Idempotent per pid.
   */
  terminate(entry: CliRegistration, delayMs: number = CLI_TEARDOWN_GRACE_MS): void {
    if (this.terminating.has(entry.pid)) return
    this.terminating.add(entry.pid)
    const signal = (sig: NodeJS.Signals): boolean => {
      if (!this.isAlive(entry)) return false
      try { this.deps.kill(entry.pid, sig); return true } catch { return false }
    }
    const done = () => {
      this.terminating.delete(entry.pid)
      if (this.entries.get(entry.pid) === entry) this.entries.delete(entry.pid)
    }
    this.deps.setTimer(() => {
      if (!signal('SIGTERM')) return done()
      this.deps.setTimer(() => {
        signal('SIGKILL')
        done()
      }, CLI_SIGKILL_GRACE_MS)
    }, delayMs)
  }

  /** Terminate what an owner has registered now (CLIs spawned after this call are not affected). */
  terminateOwner(ownerId: string, filter: { kind?: CliKind } = {}, delayMs: number = CLI_TEARDOWN_GRACE_MS): CliRegistration[] {
    const targets = [...this.entries.values()].filter(e => e.ownerId === ownerId && (!filter.kind || e.kind === filter.kind))
    for (const e of targets) this.terminate(e, delayMs)
    return targets
  }

  /**
   * Reaper backstop. Terminates registered CLIs that no live runtime can reach:
   * - the owner agent was destroyed (`retireOwner`), any kind;
   * - a persistent CLI from an older generation than its owner's current query;
   * - a persistent CLI whose owner is not among `liveOwners` (no session references that agent).
   * The last two only once the CLI is older than `minAgeMs`.
   */
  sweep(liveOwners: ReadonlySet<string>, minAgeMs: number = CLI_ORPHAN_MIN_AGE_MS): CliSweepResult {
    this.prune()
    const now = this.deps.now()
    const terminated: CliRegistration[] = []
    for (const e of this.entries.values()) {
      if (this.terminating.has(e.pid)) continue
      const retired = this.retiredOwners.has(e.ownerId)
      const oldEnough = now - e.registeredAt >= minAgeMs
      const current = this.ownerGenerations.get(e.ownerId)
      const stale = e.kind === 'persistent' && oldEnough && (
        (current !== undefined && e.generation < current) || !liveOwners.has(e.ownerId)
      )
      if (retired || stale) {
        this.terminate(e, 0)
        terminated.push(e)
      }
    }
    // A retired owner with nothing left to clean up needs no further bookkeeping.
    for (const owner of this.retiredOwners) {
      if (![...this.entries.values()].some(e => e.ownerId === owner)) this.retiredOwners.delete(owner)
    }
    return { tracked: this.entries.size, terminated }
  }

  private prune(): void {
    for (const [pid, e] of this.entries) {
      if (!this.terminating.has(pid) && !this.isAlive(e)) this.entries.delete(pid)
    }
  }
}

/** Process-wide registry (one server process, many agents). */
export const cliProcessRegistry = new CliProcessRegistry()
