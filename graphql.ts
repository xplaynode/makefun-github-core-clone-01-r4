// GraphQL v4 surface: a small parser and executor for the document shapes gh
// and github-mcp-server send (queries, mutations, aliases, inline fragments,
// input objects, enum lists, variables, operation batching), plus the __type
// introspection probes. Everything resolves against the shared store, so a
// repository read over GraphQL is the same object REST and MCP see.

import {
  forgeUsers,
  store,
  viewer,
  type RepoRec,
  type RowRec,
} from './core.ts';
import { changedFiles, mergePullRow, mergeWouldConflict } from './rest.ts';

export interface GraphqlExchange {
  body: Buffer;
  authed: boolean;
  respond(status: number, body: string | Buffer, contentType?: string, headers?: Record<string, string>): void;
  respondJson(status: number, value: unknown, headers?: Record<string, string>): void;
}

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, and decodable back to the record.
// ---------------------------------------------------------------------------

export function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(gid: string): { type: string; id: number } | null {
  try {
    const text = Buffer.from(gid, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const id = Number.parseInt(text.slice(colon + 1), 10);
    if (!Number.isFinite(id)) return null;
    return { type: text.slice(0, colon), id };
  } catch {
    return null;
  }
}

function findRowById(id: number): { repo: RepoRec; row: RowRec } | null {
  for (const repo of store.repos.values()) {
    for (const row of repo.rows.values()) {
      if (row.id === id) return { repo, row };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lexer and parser for the GraphQL subset the documents use.
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface ParsedDocument {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class ParseFailure extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$=@!|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new ParseFailure('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new ParseFailure('unterminated string');
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (nameMatch) {
      tokens.push(nameMatch[0]);
      i += nameMatch[0].length;
      continue;
    }
    const numberMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
    if (numberMatch) {
      tokens.push(numberMatch[0]);
      i += numberMatch[0].length;
      continue;
    }
    throw new ParseFailure(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseFailure('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseFailure(`expected ${token}, got ${got}`);
  }

  parseDocument(): ParsedDocument {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        const after = this.peek();
        if (after !== undefined && after !== '(' && after !== '{') name = this.next();
        if (this.peek() === '(') this.parseVariableDefinitions();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new ParseFailure(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.peek() === '=') {
        this.next();
        this.parseValue();
      }
      if (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') this.parseArguments();
      }
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = this.peek() === '(' ? this.parseArguments() : new Map<string, Value>();
    if (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.parseArguments();
    }
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { name, alias, args, selectionSet };
  }

  private parseArguments(): Map<string, Value> {
    this.expect('(');
    const args = new Map<string, Value>();
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d/.test(token)) return { kind: 'number', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function evaluate(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evaluate(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = evaluate(inner, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema and execution
// ---------------------------------------------------------------------------

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

type Resolver = (source: never, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields?: Record<string, { type: string; resolve: Resolver }>;
  enumValues?: string[];
}

interface IssueSource {
  repo: RepoRec;
  row: RowRec;
}

function issueSource(repo: RepoRec, row: RowRec): IssueSource {
  return { repo, row };
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return 0;
    const value = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

const asRepo = (source: never): RepoRec => source as unknown as RepoRec;
const asIssue = (source: never): IssueSource => source as unknown as IssueSource;

const TYPES: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: {
        type: 'User',
        resolve: () => viewer(),
      },
      repository: {
        type: 'Repository',
        resolve: (_s, args) => {
          const repo = store.repo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo ?? null;
        },
      },
      node: {
        type: 'Node',
        resolve: (_s, args) => {
          const decoded = decodeGlobalId(String(args.id ?? ''));
          if (!decoded || decoded.type !== 'Repository') return null;
          const repo = store.reposById.get(decoded.id);
          return repo ? { __typeName: 'Repository', value: repo } : null;
        },
      },
      __type: {
        type: '__Type',
        resolve: (_s, args) => {
          const name = String(args.name ?? '');
          return TYPES[name] ? { name } : null;
        },
      },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
          const repo = decoded ? store.reposById.get(decoded.id) : undefined;
          if (!repo) {
            ctx.errors.push({ message: 'repositoryId does not name a repository' });
            return { issue: null };
          }
          const row = store.createRow(repo, 'issue', String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
          return { issue: issueSource(repo, row) };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.issueId ?? ''));
          const found = decoded ? findRowById(decoded.id) : null;
          if (!found) {
            ctx.errors.push({ message: 'issueId does not name an issue' });
            return { issue: null };
          }
          found.row.state = 'closed';
          found.repo.rowVersion += 1;
          return { issue: issueSource(found.repo, found.row) };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
          const repo = decoded ? store.reposById.get(decoded.id) : undefined;
          if (!repo) {
            ctx.errors.push({ message: 'repositoryId does not name a repository' });
            return { pullRequest: null };
          }
          const headRef = String(input.headRefName ?? '');
          const baseRef = String(input.baseRefName ?? '');
          const headTip = repo.refs.get(`refs/heads/${headRef}`);
          if (!headTip || !repo.refs.get(`refs/heads/${baseRef}`)) {
            ctx.errors.push({ message: 'head or base branch does not exist' });
            return { pullRequest: null };
          }
          const row = store.createRow(repo, 'pull', String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
          row.headRef = headRef;
          row.baseRef = baseRef;
          row.headSha = headTip;
          return { pullRequest: issueSource(repo, row) };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
          const found = decoded ? findRowById(decoded.id) : null;
          if (!found || found.row.kind !== 'pull') {
            ctx.errors.push({ message: 'pullRequestId does not name a pull request' });
            return { pullRequest: null };
          }
          const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
          const result = mergePullRow(found.repo, found.row, method);
          if (result !== 'conflict' && result !== 'gone') return { pullRequest: issueSource(found.repo, found.row) };
          ctx.errors.push({ message: 'pull request is not mergeable' });
          return { pullRequest: issueSource(found.repo, found.row) };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.subjectId ?? ''));
          const found = decoded ? findRowById(decoded.id) : null;
          if (!found) {
            ctx.errors.push({ message: 'subjectId does not name an issue' });
            return { commentEdge: null };
          }
          const comment = store.addComment(found.repo, found.row.number, String(input.body ?? ''));
          return { commentEdge: { node: { id: globalId('IssueComment', comment.id), body: comment.body } } };
        },
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      login: { type: 'String', resolve: (s) => (s as unknown as { login: string }).login },
      id: { type: 'ID', resolve: (s) => globalId('User', (s as unknown as { id: number }).id) },
      name: { type: 'String', resolve: (s) => (s as unknown as { name: string }).name },
      email: { type: 'String', resolve: (s) => (s as unknown as { email: string }).email },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('Repository', asRepo(s).id) },
      databaseId: { type: 'Int', resolve: (s) => asRepo(s).id },
      name: { type: 'String', resolve: (s) => asRepo(s).name },
      nameWithOwner: { type: 'String', resolve: (s) => `${asRepo(s).owner}/${asRepo(s).name}` },
      owner: {
        type: 'User',
        resolve: (s) => forgeUsers().find((user) => user.login === asRepo(s).owner) ?? viewer(),
      },
      description: { type: 'String', resolve: (s) => asRepo(s).description },
      isPrivate: { type: 'Boolean', resolve: (s) => asRepo(s).priv },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (s) => {
          const repo = asRepo(s);
          return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null;
        },
      },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      issue: {
        type: 'Issue',
        resolve: (s, args) => {
          const repo = asRepo(s);
          const row = repo.rows.get(Number(args.number));
          return row ? issueSource(repo, row) : null;
        },
      },
      issues: {
        type: 'IssueConnection',
        resolve: (s, args) => {
          const repo = asRepo(s);
          let rows = [...repo.rows.values()].filter((row) => row.kind === 'issue');
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states) {
            const wanted = states.map((state) => state.toLowerCase());
            rows = rows.filter((row) => wanted.includes(row.state));
          }
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          rows.sort((a, b) => a.number - b.number);
          if (orderBy && orderBy.direction === 'DESC') rows.reverse();
          const first = typeof args.first === 'number' ? args.first : 30;
          const afterNumber = typeof args.after === 'string' ? numberFromCursor(args.after) : 0;
          const startIndex = afterNumber > 0 ? rows.findIndex((row) => row.number === afterNumber) + 1 : 0;
          const page = rows.slice(startIndex, startIndex + first);
          return {
            nodes: page.map((row) => issueSource(repo, row)),
            pageInfo: {
              hasNextPage: startIndex + first < rows.length,
              endCursor: page.length ? cursorOf((page[page.length - 1] as RowRec).number) : null,
              hasPreviousPage: startIndex > 0,
              startCursor: page.length ? cursorOf((page[0] as RowRec).number) : null,
            },
            totalCount: rows.length,
          };
        },
      },
      pullRequest: {
        type: 'PullRequest',
        resolve: (s, args) => {
          const repo = asRepo(s);
          const row = repo.rows.get(Number(args.number));
          return row && row.kind === 'pull' ? issueSource(repo, row) : null;
        },
      },
      pullRequests: {
        type: 'PullRequestConnection',
        resolve: (s, args) => {
          const repo = asRepo(s);
          let rows = [...repo.rows.values()].filter((row) => row.kind === 'pull' && row.state === 'open');
          rows.sort((a, b) => a.number - b.number);
          const first = typeof args.first === 'number' ? args.first : 30;
          rows = rows.slice(0, first);
          return {
            nodes: rows.map((row) => issueSource(repo, row)),
            pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
          };
        },
      },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (s) => (s as unknown as { name: string }).name },
      prefix: { type: 'String', resolve: () => 'refs/heads/' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('Issue', asIssue(s).row.id) },
      number: { type: 'Int', resolve: (s) => asIssue(s).row.number },
      title: { type: 'String', resolve: (s) => asIssue(s).row.title },
      state: { type: 'IssueState', resolve: (s) => asIssue(s).row.state.toUpperCase() },
      body: { type: 'String', resolve: (s) => asIssue(s).row.body },
      url: {
        type: 'String',
        resolve: (s) => {
          const { repo, row } = asIssue(s);
          return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${row.number}`;
        },
      },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('PullRequest', asIssue(s).row.id) },
      number: { type: 'Int', resolve: (s) => asIssue(s).row.number },
      title: { type: 'String', resolve: (s) => asIssue(s).row.title },
      body: { type: 'String', resolve: (s) => asIssue(s).row.body },
      state: {
        type: 'PullRequestState',
        resolve: (s) => {
          const row = asIssue(s).row;
          return row.merged ? 'MERGED' : row.state.toUpperCase();
        },
      },
      merged: { type: 'Boolean', resolve: (s) => asIssue(s).row.merged },
      mergeable: {
        type: 'MergeableState',
        resolve: (s) => {
          const { repo, row } = asIssue(s);
          if (row.merged || row.state === 'closed') return 'UNKNOWN';
          const baseTip = repo.refs.get(`refs/heads/${row.baseRef}`);
          const headTip = repo.refs.get(`refs/heads/${row.headRef}`);
          if (!baseTip || !headTip) return 'UNKNOWN';
          return mergeWouldConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
        },
      },
      headRefName: { type: 'String', resolve: (s) => asIssue(s).row.headRef },
      baseRefName: { type: 'String', resolve: (s) => asIssue(s).row.baseRef },
      files: {
        type: 'PullRequestChangedFileConnection',
        resolve: (s, args) => {
          const { repo, row } = asIssue(s);
          const baseTip = repo.refs.get(`refs/heads/${row.baseRef}`);
          const headTip = repo.refs.get(`refs/heads/${row.headRef}`) ?? row.headSha;
          if (!baseTip || !headTip) return { nodes: [] };
          const first = typeof args.first === 'number' ? args.first : 30;
          return { nodes: changedFiles(repo, baseTip, headTip).slice(0, first).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })) };
        },
      },
      url: {
        type: 'String',
        resolve: (s) => {
          const { repo, row } = asIssue(s);
          return `https://forge.invalid/${repo.owner}/${repo.name}/pull/${row.number}`;
        },
      },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]', resolve: (s) => (s as unknown as { nodes: unknown }).nodes },
      pageInfo: { type: 'PageInfo', resolve: (s) => (s as unknown as { pageInfo: unknown }).pageInfo },
      totalCount: { type: 'Int', resolve: (s) => (s as unknown as { totalCount: number }).totalCount },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]', resolve: (s) => (s as unknown as { nodes: unknown }).nodes },
      pageInfo: { type: 'PageInfo', resolve: (s) => (s as unknown as { pageInfo: unknown }).pageInfo },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean', resolve: (s) => (s as unknown as { hasNextPage: boolean }).hasNextPage },
      endCursor: { type: 'String', resolve: (s) => (s as unknown as { endCursor: string | null }).endCursor },
      hasPreviousPage: { type: 'Boolean', resolve: (s) => (s as unknown as { hasPreviousPage: boolean }).hasPreviousPage },
      startCursor: { type: 'String', resolve: (s) => (s as unknown as { startCursor: string | null }).startCursor },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]', resolve: (s) => (s as unknown as { nodes: unknown }).nodes },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String', resolve: (s) => (s as unknown as { path: string }).path },
      additions: { type: 'Int', resolve: (s) => (s as unknown as { additions: number }).additions },
      deletions: { type: 'Int', resolve: (s) => (s as unknown as { deletions: number }).deletions },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: { type: 'Issue', resolve: (s) => (s as unknown as { issue: unknown }).issue } },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: { type: 'Issue', resolve: (s) => (s as unknown as { issue: unknown }).issue } },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest', resolve: (s) => (s as unknown as { pullRequest: unknown }).pullRequest } },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest', resolve: (s) => (s as unknown as { pullRequest: unknown }).pullRequest } },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { commentEdge: { type: 'CommentEdge', resolve: (s) => (s as unknown as { commentEdge: unknown }).commentEdge } },
  },
  CommentEdge: {
    kind: 'OBJECT',
    fields: { node: { type: 'Comment', resolve: (s) => (s as unknown as { node: unknown }).node } },
  },
  Comment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => (s as unknown as { id: string }).id },
      body: { type: 'String', resolve: (s) => (s as unknown as { body: string }).body },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (s) => (s as unknown as { name: string }).name },
      kind: {
        type: 'String',
        resolve: (s) => {
          const def = TYPES[(s as unknown as { name: string }).name];
          return def ? def.kind : 'OBJECT';
        },
      },
      fields: {
        type: '[__Field]',
        resolve: (s) => {
          const def = TYPES[(s as unknown as { name: string }).name];
          if (!def || def.kind !== 'OBJECT' || !def.fields) return null;
          return Object.keys(def.fields).map((name) => ({ name }));
        },
      },
      enumValues: {
        type: '[__EnumValue]',
        resolve: (s) => {
          const def = TYPES[(s as unknown as { name: string }).name];
          if (!def || def.kind !== 'ENUM' || !def.enumValues) return null;
          return def.enumValues.map((name) => ({ name }));
        },
      },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: { name: { type: 'String', resolve: (s) => (s as unknown as { name: string }).name } },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: { name: { type: 'String', resolve: (s) => (s as unknown as { name: string }).name } },
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

function baseTypeName(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

function executeSelectionSet(
  typeName: string,
  source: unknown,
  selections: SelectionNode[],
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = TYPES[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        Object.assign(out, executeSelectionSet(typeName, source, fragment.selectionSet, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fieldDef = typeDef?.fields?.[field.name];
    if (!fieldDef) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of field.args) args[argName] = evaluate(argValue, ctx.variables);
    const value = (fieldDef.resolve as (s: unknown, a: Record<string, unknown>, c: Ctx) => unknown)(source, args, ctx);
    out[key] = completeValue(fieldDef.type, value, field, ctx);
  }
  return out;
}

function completeValue(type: string, value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const itemType = baseTypeName(type);
    return value.map((item) => completeValue(itemType, item, field, ctx));
  }
  const typeName = baseTypeName(type);
  // Interface dispatch (Query.node): the resolver tagged the concrete type.
  if (typeof value === 'object' && value !== null && '__typeName' in (value as Record<string, unknown>)) {
    const tagged = value as { __typeName: string; value: unknown };
    return executeSelectionSet(tagged.__typeName, tagged.value, field.selectionSet, ctx);
  }
  const def = TYPES[typeName];
  if (!def || def.kind !== 'OBJECT') return value;
  if (!field.selectionSet) return value;
  return executeSelectionSet(typeName, value, field.selectionSet, ctx);
}

function executeOperation(operation: OperationNode, variables: Record<string, unknown>, fragments: Ctx['fragments']): Record<string, unknown> {
  const ctx: Ctx = { variables, fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, null, operation.selectionSet, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export function handleGraphql(ex: GraphqlExchange): void {
  if (!ex.authed) {
    ex.respondJson(401, { message: 'Requires authentication' });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(ex.body.toString('utf8'));
  } catch {
    ex.respondJson(400, { message: 'Invalid JSON' });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Invalid operation' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let document: ParsedDocument;
    try {
      document = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
    const operation = operationName
      ? (document.operations.find((op) => op.name === operationName) ?? document.operations[0])
      : document.operations[0];
    if (!operation) return { data: null, errors: [{ message: 'No operation in document' }] };
    return executeOperation(operation, variables, document.fragments);
  };
  if (Array.isArray(body)) {
    const results = body.map(runOne);
    ex.respond(200, JSON.stringify(results), JSON_TYPE);
    return;
  }
  const result = runOne(body);
  ex.respond(200, JSON.stringify(result), JSON_TYPE);
}
