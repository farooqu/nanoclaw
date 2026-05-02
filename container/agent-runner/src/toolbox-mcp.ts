/**
 * Toolbox MCP server — standalone stdio server registered as "tb".
 *
 * Exposes toolkit tools as mcp__tb__* rather than mcp__nanoclaw__*,
 * keeping the toolbox namespace separate from nanoclaw's built-in tools.
 *
 * Reads /workspace/agent/.toolkit-schema.json (written by the host at
 * spawn time) to discover tools. Tool calls use the same round-trip as
 * ask_user_question: write a toolkit_op system action to outbound.db,
 * poll inbound.db for the host's response.
 *
 * Credentials and role enforcement happen entirely host-side.
 */
import fs from 'fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { findQuestionResponse, markCompleted } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getSessionRouting } from './db/session-routing.js';

const SCHEMA_PATH = '/workspace/agent/.toolkit-schema.json';
const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 120_000;

function log(msg: string): void {
  console.error(`[toolbox-mcp] ${msg}`);
}

function generateId(): string {
  return `tb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface ToolkitToolEntry {
  name: string;
  description: string;
  domain: string;
  executablePath: string;
  routingKey: string | null;
  routingValue: string | null;
  inputSchema: Record<string, unknown>;
}

interface ToolkitSchema {
  libDir: string;
  tools: ToolkitToolEntry[];
}

function loadSchema(): ToolkitSchema | null {
  if (!fs.existsSync(SCHEMA_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as ToolkitSchema;
  } catch (e) {
    log(`Failed to parse schema: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool execution via outbound.db → inbound.db round-trip
// ---------------------------------------------------------------------------

async function callToolkitTool(
  entry: ToolkitToolEntry,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const requestId = generateId();
  const routing = getSessionRouting();

  writeMessageOut({
    id: requestId,
    kind: 'system',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    content: JSON.stringify({
      action: 'toolkit_op',
      name: entry.name,
      requestId,
      args,
    }),
  });

  log(`${entry.name}: request ${requestId}`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = findQuestionResponse(requestId);
    if (response) {
      const parsed = JSON.parse(response.content) as {
        status: string;
        result: { output?: string; error?: string };
      };
      markCompleted([response.id]);
      log(`${entry.name}: response (status=${parsed.status})`);

      if (parsed.status === 'error') {
        return {
          content: [{ type: 'text', text: `Error: ${parsed.result.error ?? 'Unknown error'}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: parsed.result.output ?? '' }] };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  log(`${entry.name}: timed out`);
  return {
    content: [{ type: 'text', text: `Error: Toolkit operation timed out after ${TIMEOUT_MS / 1000}s` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const schema = loadSchema();

  if (!schema || schema.tools.length === 0) {
    log('No toolkit schema or no tools — exiting');
    process.exit(0);
  }

  const toolMap = new Map(schema.tools.map(t => [t.name, t]));

  const server = new Server(
    { name: 'tb', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: schema.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as {
        type: 'object';
        properties?: Record<string, object>;
        required?: string[];
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = toolMap.get(name);
    if (!entry) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return callToolkitTool(entry, (args ?? {}) as Record<string, unknown>);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`Started with ${schema.tools.length} tools: ${schema.tools.map(t => t.name).join(', ')}`);
}

main().catch(err => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
