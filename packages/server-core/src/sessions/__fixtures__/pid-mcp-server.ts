// Minimal stdio MCP server for idle-runtime-eviction.isolated.ts: one `whoami`
// tool that returns the server's pid, so a test can check the child process
// is reaped on dispose and a fresh one serves the tool after resume.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'pid-fixture', version: '1.0.0' })
server.registerTool('whoami', { description: 'Return this server process pid' }, async () => ({
  content: [{ type: 'text', text: String(process.pid) }],
}))
await server.connect(new StdioServerTransport())
