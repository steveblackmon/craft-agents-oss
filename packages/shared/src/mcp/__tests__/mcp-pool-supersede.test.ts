/**
 * craft-agents#250: a connect spans an await (spawn + handshake). A client that finishes
 * connecting after its pool/slug was disconnected, or after another client took the slug, must be
 * closed. Registering it over the winner (or into a dropped pool) left its stdio MCP server
 * running with nothing referencing it.
 */

import { describe, expect, test } from 'bun:test'
import { McpClientPool } from '../mcp-pool.ts'
import type { PoolClient } from '../client.ts'

interface FakeClient extends PoolClient {
  name: string
  closed: boolean
  resolve: () => void
  reject: (e: Error) => void
}

class DeferredPool extends McpClientPool {
  made: FakeClient[] = []

  /** Starts a connect whose handshake completes when the test says so. */
  start(slug: string): { client: FakeClient; done: Promise<boolean> } {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const handshake = new Promise<[]>((res, rej) => { resolve = () => res([]); reject = rej })
    const client: FakeClient = {
      name: `${slug}#${this.made.length + 1}`,
      closed: false,
      resolve,
      reject,
      listTools: () => handshake,
      callTool: async () => ({ content: [] }),
      close: async () => { client.closed = true },
    }
    this.made.push(client)
    return { client, done: this.registerClient(slug, client) }
  }

  connected(slug: string): PoolClient | undefined {
    return (this as unknown as { clients: Map<string, PoolClient> }).clients.get(slug)
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('McpClientPool late-connection handling', () => {
  test('two concurrent connects of one slug: the first registers, the second is closed', async () => {
    const pool = new DeferredPool()
    const a = pool.start('tekton')
    const b = pool.start('tekton')
    a.client.resolve(); await a.done
    b.client.resolve()
    expect(await b.done).toBe(false)
    expect(pool.connected('tekton')).toBe(a.client)
    expect(a.client.closed).toBe(false)
    expect(b.client.closed).toBe(true)
  })

  test('disconnectAll during a connect (idle reap): the late client is closed, not registered', async () => {
    const pool = new DeferredPool()
    const a = pool.start('tekton')
    await pool.disconnectAll()
    a.client.resolve()
    expect(await a.done).toBe(false)
    expect(a.client.closed).toBe(true)
    expect(pool.isConnected('tekton')).toBe(false)
  })

  test('disconnect(slug) during a connect: the late client is closed; a fresh connect still works', async () => {
    const pool = new DeferredPool()
    const a = pool.start('tekton')
    await pool.disconnect('tekton')
    const b = pool.start('tekton')
    a.client.resolve()
    b.client.resolve()
    expect(await a.done).toBe(false)
    expect(await b.done).toBe(true)
    expect(a.client.closed).toBe(true)
    expect(pool.connected('tekton')).toBe(b.client)
  })

  test('a connect that fails closes its client', async () => {
    const pool = new DeferredPool()
    const a = pool.start('tekton')
    a.client.reject(new Error('handshake failed'))
    await expect(a.done).rejects.toThrow('handshake failed')
    expect(a.client.closed).toBe(true)
  })

  test('connect(): concurrent calls share one in-flight attempt; a disconnect in between does not', async () => {
    const pool = new McpClientPool()
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    ;(pool as unknown as { registerClient: (slug: string) => Promise<boolean> }).registerClient = async (slug: string) => {
      seen.push(slug)
      await gate
      return true
    }
    const cfg = { type: 'http' as const, url: 'https://mcp.example.test/mcp' }
    const one = pool.connect('craft', cfg)
    const two = pool.connect('craft', cfg)
    await tick()
    expect(seen).toEqual(['craft'])
    await pool.disconnect('craft')
    const three = pool.connect('craft', cfg)
    await tick()
    expect(seen).toEqual(['craft', 'craft'])
    release()
    await Promise.all([one, two, three])
  })
})
