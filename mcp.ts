// MCP surface: Streamable-HTTP JSON-RPC at /mcp. Speaks the modern
// server/discover era (2026-07-28) and the legacy initialize handshake, and
// serves six tools that operate on the same store as REST and GraphQL, so an
// object created over MCP is the same object everywhere.

import { store, viewer } from './core.ts';
import { issueJson, mergePullRow, pullJson, repoJson } from './rest.ts';

export interface McpExchange {
  body: Buffer;
  authed: boolean;
  respond(status: number, body: string | Buffer, contentType?: string, headers?: Record<string, string>): void;
  respondJson(status: number, value: unknown, headers?: Record<string, string>): void;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_INFO = { name: 'lucky-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Issue state filter: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function requiredArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  const schema = tool.inputSchema as { required?: string[] };
  return (schema.required ?? []).filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcError: { code: number; message: string } } {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = requiredArgs(tool, args);
  if (missing.length > 0) return toolError(`missing required arguments: ${missing.join(', ')}`);
  const owner = typeof args.owner === 'string' ? args.owner : viewer().login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      if (store.repo(viewer().login, repoNameArg)) return toolError(`a repository named ${repoNameArg} already exists`);
      const repo = store.createRepo(
        viewer().login,
        repoNameArg,
        typeof args.description === 'string' ? args.description : '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.repo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.repo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const row = store.createRow(repo, 'issue', String(args.title ?? ''), typeof args.body === 'string' ? args.body : '');
      return toolResult(issueJson(repo, row));
    }
    case 'list_issues': {
      const repo = store.repo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const rows = [...repo.rows.values()]
        .filter((row) => row.kind === 'issue' && (state === 'all' || row.state === state))
        .sort((a, b) => a.number - b.number);
      const issues = rows.map((row) => issueJson(repo, row));
      return {
        content: [{ type: 'text', text: JSON.stringify(issues) }],
        structuredContent: { issues },
        isError: false,
      };
    }
    case 'create_pull_request': {
      const repo = store.repo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headTip = repo.refs.get(`refs/heads/${head}`);
      if (!headTip) return toolError(`head branch ${head} does not exist`);
      if (!repo.refs.get(`refs/heads/${base}`)) return toolError(`base branch ${base} does not exist`);
      const row = store.createRow(repo, 'pull', String(args.title ?? ''), typeof args.body === 'string' ? args.body : '');
      row.headRef = head;
      row.baseRef = base;
      row.headSha = headTip;
      return toolResult(pullJson(repo, row));
    }
    case 'merge_pull_request': {
      const repo = store.repo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const row = repo.rows.get(number);
      if (!row || row.kind !== 'pull') return toolError(`pull request #${number} not found`);
      if (row.merged) return toolError(`pull request #${number} is already merged`);
      const result = mergePullRow(repo, row, 'squash');
      if (result === 'conflict') return toolError(`pull request #${number} is not mergeable: conflict`);
      if (result === 'gone') return toolError(`pull request #${number} is not mergeable: a branch is missing`);
      return toolResult(pullJson(repo, row));
    }
  }
  return toolError(`unhandled tool ${name}`);
}

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

function handleRpc(request: Record<string, unknown>): { status: number; payload: Record<string, unknown> | null } {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = 'id' in request ? request.id : undefined;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  if (id === undefined) {
    // A notification: accepted, never answered.
    return { status: 202, payload: null };
  }
  const ok = (result: unknown): { status: number; payload: Record<string, unknown> } => ({
    status: 200,
    payload: { jsonrpc: '2.0', id, result },
  });
  const err = (code: number, message: string): { status: number; payload: Record<string, unknown> } => ({
    status: 200,
    payload: { jsonrpc: '2.0', id, error: { code, message } },
  });
  switch (method) {
    case 'server/discover':
      return ok(discoverResult());
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return ok({ protocolVersion: offered, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const result = callTool(name, args);
      if ('rpcError' in result) return err(result.rpcError.code, result.rpcError.message);
      return ok(result);
    }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

export function handleMcp(ex: McpExchange): void {
  const text = ex.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    ex.respond(400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), JSON_TYPE);
    return;
  }
  if (!ex.authed) {
    ex.respond(401, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }), JSON_TYPE);
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
      const handled = handleRpc(entry as Record<string, unknown>);
      return handled.payload ?? { jsonrpc: '2.0', id: null, result: {} };
    });
    ex.respond(200, JSON.stringify(results), JSON_TYPE);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    ex.respond(400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }), JSON_TYPE);
    return;
  }
  const handled = handleRpc(parsed as Record<string, unknown>);
  if (handled.payload === null) {
    ex.respond(202, '', JSON_TYPE);
    return;
  }
  ex.respond(handled.status, JSON.stringify(handled.payload), JSON_TYPE);
}
