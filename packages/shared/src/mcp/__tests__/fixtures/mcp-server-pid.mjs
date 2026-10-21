#!/usr/bin/env node
// Minimal stdio MCP server for shared-child tests: its `pid` tool reports the
// server's process id (and the CRAFT_SESSION_DIR it inherited), so tests can
// tell whether two pools talk to the same child.

import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

rl.on('line', (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-server-pid', version: '1.0.0' },
      },
    })
  } else if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { tools: [{ name: 'pid', description: 'Report the server pid', inputSchema: { type: 'object', properties: {} } }] },
    })
  } else if (req.method === 'tools/call') {
    const text = JSON.stringify({ pid: process.pid, sessionDir: process.env.CRAFT_SESSION_DIR ?? null, tag: process.env.FIXTURE_TAG ?? null })
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }] } })
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } })
  }
})
