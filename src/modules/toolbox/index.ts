/**
 * Toolbox adapter — host-side bridge between nanoclaw and ai-toolkit tools.
 *
 * At container spawn time, `generateToolkitSchema` discovers toolkit tools
 * for the agent group's configured domains by running each executable with
 * TOOLBOX_ACTION=describe, converts them to MCP-compatible schemas, and
 * writes the result to groups/<folder>/.toolkit-schema.json. The container
 * MCP server reads this file at startup and registers the tools.
 *
 * At runtime, the container sends `toolkit_op` system actions through
 * outbound.db. The delivery action handler here validates the request
 * against the group's toolboxConfig (domain check + role), executes the
 * tool with TOOLBOX_ROLE set, and writes the result back to inbound.db
 * via writeSystemResponse so the container's poll loop picks it up.
 *
 * Credentials never enter the container — they live in the host environment
 * (managed by OneCLI) and are only used here during tool execution.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, TOOLBOX_DIR } from '../../config.js';
import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { writeSystemResponse } from '../../session-manager.js';

const SCHEMA_FILE = '.toolkit-schema.json';
const DOMAIN_RE = /^[a-z0-9_-]+$/i;
const DESCRIBE_TIMEOUT_MS = 10_000;
const EXECUTE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Schema types (shared between generation and execution)
// ---------------------------------------------------------------------------

export interface ToolkitToolEntry {
  /** MCP tool name as registered in the container, e.g. "toolkit_email_list". */
  name: string;
  description: string;
  domain: string;
  /** Absolute path to the executable on the host. */
  executablePath: string;
  /** Routing key ("action" | "command") for multi-action tools, null for flat tools. */
  routingKey: string | null;
  /** Value to inject for the routing key, e.g. "list". Null for flat tools. */
  routingValue: string | null;
  inputSchema: Record<string, unknown>;
}

export interface ToolkitSchema {
  /** Path to the toolkit lib dir (for PYTHONPATH). Derived from resolved executable path. */
  libDir: string;
  tools: ToolkitToolEntry[];
}

// ---------------------------------------------------------------------------
// Schema generation (host-side, called at container spawn time)
// ---------------------------------------------------------------------------

function validateDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain) && !domain.includes('..');
}

function describeExecutable(exePath: string, role: string): Record<string, unknown> | null {
  const result = spawnSync(exePath, [], {
    env: { ...process.env, TOOLBOX_ACTION: 'describe', TOOLBOX_ROLE: role },
    timeout: DESCRIBE_TIMEOUT_MS,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout?.trim()) return null;
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Derive the toolkit lib dir from a real (symlink-resolved) executable path.
 *
 * Toolkit structure: ai-toolkit/toolkit/<domain>/bin/<exe>
 * Lib dir:           ai-toolkit/framework/tools/lib
 */
function deriveLibDir(realExePath: string): string {
  const toolkitRoot = path.dirname(path.dirname(path.dirname(path.dirname(realExePath))));
  return path.join(toolkitRoot, 'framework', 'tools', 'lib');
}

function parseArg(argDesc: string): { prop: Record<string, unknown>; optional: boolean } {
  const parts = argDesc.split(' - ', 2);
  const typePart = parts[0].trim();
  const desc = parts[1]?.trim() ?? '';
  const optional = typePart.endsWith('?');
  let baseType = typePart.replace(/\?$/, '');
  if (baseType.includes('|')) baseType = baseType.split('|')[0];
  if (baseType.startsWith('array')) baseType = 'array';
  const typeMap: Record<string, string> = {
    string: 'string', number: 'number', boolean: 'boolean',
    object: 'object', array: 'array',
  };
  return { prop: { type: typeMap[baseType] ?? 'string', description: desc }, optional };
}

function schemaToMcpTools(schema: Record<string, unknown>, executablePath: string): ToolkitToolEntry[] {
  const baseName = schema.name as string;
  const fullDesc = (schema.description as string) ?? '';
  const args = (schema.args as Record<string, string>) ?? {};

  const routingKey = 'action' in args ? 'action' : 'command' in args ? 'command' : null;
  const actionMatches = [...fullDesc.matchAll(/(\w+): ([^.]+)\./g)].map(m => [m[1], m[2]] as [string, string]);

  if (!routingKey || actionMatches.length === 0) {
    // Flat tool — single MCP entry
    const properties: Record<string, unknown> = {};
    for (const [argName, argDesc] of Object.entries(args)) {
      properties[argName] = parseArg(argDesc).prop;
    }
    return [{
      name: baseName,
      description: fullDesc,
      domain: '',
      executablePath,
      routingKey: null,
      routingValue: null,
      inputSchema: { type: 'object', properties },
    }];
  }

  // Multi-action tool — split into one MCP entry per action
  return actionMatches.map(([action, actionDesc]) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [argName, argDesc] of Object.entries(args)) {
      if (argName === routingKey) continue;
      const isGlobal = !argDesc.includes('for ');
      const forMatch = argDesc.match(/\((?:required )?for ([^)]+)\)/);
      const allowedActions = forMatch ? forMatch[1].split(',').map(s => s.trim()) : [];
      const isForThis = allowedActions.includes(action) || allowedActions.includes('any');
      if (!isGlobal && !isForThis) continue;

      const { prop } = parseArg(argDesc);
      properties[argName] = prop;

      const reqMatch = argDesc.match(/\(required for ([^)]+)\)/);
      if (reqMatch) {
        const reqActions = reqMatch[1].split(',').map(s => s.trim());
        if (reqActions.includes(action) || reqActions.includes('any')) required.push(argName);
      }
    }

    const inputSchema: Record<string, unknown> = { type: 'object', properties };
    if (required.length > 0) inputSchema.required = required;

    return {
      name: `${baseName}_${action}`,
      description: `${baseName} ${action}: ${actionDesc.trim()}`,
      domain: '',
      executablePath,
      routingKey,
      routingValue: action,
      inputSchema,
    };
  });
}

/**
 * Generate the toolkit schema file for an agent group.
 * Called at container spawn time. Writes to groups/<folder>/.toolkit-schema.json.
 * Skipped (and existing file removed) when toolboxConfig is absent or incomplete.
 */
export function generateToolkitSchema(folder: string): void {
  const schemaPath = path.join(GROUPS_DIR, folder, SCHEMA_FILE);
  const config = readContainerConfig(folder);
  const tc = config.toolboxConfig;

  if (!tc?.role || !tc.domains?.length) {
    if (fs.existsSync(schemaPath)) fs.unlinkSync(schemaPath);
    return;
  }

  let libDir = '';
  const tools: ToolkitToolEntry[] = [];

  for (const domain of tc.domains) {
    if (!validateDomain(domain)) {
      log.warn('Toolbox: invalid domain name, skipping', { domain });
      continue;
    }

    const binDir = path.join(TOOLBOX_DIR, domain, 'bin');
    if (!fs.existsSync(binDir)) {
      log.warn('Toolbox: domain bin dir not found, skipping', { domain, binDir });
      continue;
    }

    const executables = fs.readdirSync(binDir).filter(f => {
      try {
        fs.accessSync(path.join(binDir, f), fs.constants.X_OK);
        return true;
      } catch { return false; }
    });

    for (const exe of executables) {
      if (exe.startsWith('.') || exe.startsWith('_')) continue;
      const exePath = path.join(binDir, exe);
      const schema = describeExecutable(exePath, tc.role);
      if (!schema) {
        log.warn('Toolbox: describe failed, skipping executable', { exePath });
        continue;
      }

      const entries = schemaToMcpTools(schema, exePath);
      for (const entry of entries) {
        entry.domain = domain;
        tools.push(entry);
      }

      if (!libDir) {
        try {
          const real = fs.realpathSync(exePath);
          const candidate = deriveLibDir(real);
          if (fs.existsSync(candidate)) libDir = candidate;
        } catch { /* best-effort */ }
      }
    }
  }

  const output: ToolkitSchema = { libDir, tools };
  fs.writeFileSync(schemaPath, JSON.stringify(output, null, 2) + '\n');
  log.info('Toolbox: schema generated', { folder, toolCount: tools.length, libDir });
}

// ---------------------------------------------------------------------------
// Runtime execution (host-side delivery action handler)
// ---------------------------------------------------------------------------

function executeToolkitTool(
  entry: ToolkitToolEntry,
  role: string,
  libDir: string,
  args: Record<string, unknown>,
): { output: string } | { error: string } {
  const injectedArgs = { ...args };
  if (entry.routingKey && entry.routingValue) {
    injectedArgs[entry.routingKey] = entry.routingValue;
  }

  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    TOOLBOX_ACTION: 'execute',
    TOOLBOX_ROLE: role,
  };
  if (libDir) {
    env.PYTHONPATH = libDir + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : '');
  }

  const result = spawnSync(entry.executablePath, [], {
    input: JSON.stringify(injectedArgs),
    env,
    timeout: EXECUTE_TIMEOUT_MS,
    encoding: 'utf8',
  });

  if (result.error) return { error: `Execution failed: ${result.error.message}` };
  if (result.status !== 0) {
    return { error: result.stdout?.trim() || result.stderr?.trim() || 'Tool exited with non-zero status' };
  }
  return { output: result.stdout ?? '' };
}

/**
 * Register the toolkit_op delivery action handler.
 * Self-registers on import via the call at the bottom of this file.
 */
export function registerToolboxDeliveryAction(): void {
  registerDeliveryAction('toolkit_op', async (content, session) => {
    const toolName = content.name as string | undefined;
    const requestId = content.requestId as string | undefined;
    const args = (content.args as Record<string, unknown>) ?? {};

    if (!toolName || !requestId) {
      log.warn('Toolbox: malformed toolkit_op request', { sessionId: session.id });
      return;
    }

    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) {
      log.warn('Toolbox: agent group not found', { agentGroupId: session.agent_group_id });
      return;
    }

    const tc = readContainerConfig(agentGroup.folder).toolboxConfig;
    if (!tc?.role || !tc.domains?.length) {
      writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
        error: 'Toolbox not configured for this agent group',
      });
      return;
    }

    // Load schema to find the tool entry
    const schemaPath = path.join(GROUPS_DIR, agentGroup.folder, SCHEMA_FILE);
    if (!fs.existsSync(schemaPath)) {
      writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
        error: 'Toolkit schema not found — container may need restart',
      });
      return;
    }

    let schema: ToolkitSchema;
    try {
      schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as ToolkitSchema;
    } catch {
      writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
        error: 'Failed to read toolkit schema',
      });
      return;
    }

    const entry = schema.tools.find(t => t.name === toolName);
    if (!entry) {
      writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
        error: `Unknown toolkit tool: ${toolName}`,
      });
      return;
    }

    // Domain check — tool's domain must be in this group's configured domains
    if (!tc.domains.includes(entry.domain)) {
      log.warn('Toolbox: domain not allowed for agent group', {
        tool: toolName, domain: entry.domain, allowed: tc.domains,
      });
      writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
        error: `Tool domain "${entry.domain}" is not configured for this agent group`,
      });
      return;
    }

    log.info('Toolbox: executing tool', { tool: toolName, domain: entry.domain, role: tc.role });
    const result = executeToolkitTool(entry, tc.role, schema.libDir, args);
    const status = 'error' in result ? 'error' : 'ok';
    writeSystemResponse(session.agent_group_id, session.id, requestId, status, result);
  });
}

// Self-register on import
registerToolboxDeliveryAction();
