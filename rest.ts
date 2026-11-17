// REST v3 surface: repositories, contents, branches, commits, labels, issues,
// comments and pull requests over the shared store. Every answer is JSON and
// carries an X-GitHub-Request-Id header (added by the dispatcher in app.ts).

import {
  ancestry,
  blobAtPath,
  buildCommit,
  commitFileChange,
  commitOf,
  flattenTree,
  buildTreeFromFlat,
  isAncestor,
  mergeBase,
  parseTree,
  peelToCommit,
  store,
  storeObject,
  viewer,
  type RepoRec,
  type RowRec,
} from './core.ts';

export interface Exchange {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  authed: boolean;
  host: string;
  jsonBody(): Record<string, unknown> | null;
  respond(status: number, body: string | Buffer, contentType?: string, headers?: Record<string, string>): void;
  respondJson(status: number, value: unknown, headers?: Record<string, string>): void;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const NOT_FOUND = { message: 'Not Found' };

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: viewer().id },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label ? label.color : 'ededed' };
}

export function issueJson(repo: RepoRec, row: RowRec): Record<string, unknown> {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    labels: row.labels.map((name) => labelJson(repo, name)),
  };
}

export function pullJson(repo: RepoRec, row: RowRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${row.headRef}`) ?? row.headSha;
  const baseSha = repo.refs.get(`refs/heads/${row.baseRef}`) ?? '';
  return {
    id: row.id,
    number: row.number,
    state: row.state,
    title: row.title,
    body: row.body,
    head: { ref: row.headRef, sha: headSha },
    base: { ref: row.baseRef, sha: baseSha },
    merged: row.merged,
    merged_at: row.merged ? row.mergedAt : null,
    merge_commit_sha: row.merged ? row.mergeCommitSha : null,
  };
}

// Serialized issue bodies are the read workload's hot path: cache the exact
// response text per row and drop the cache whenever the repo's rows change.
const issueTextCache = new Map<RepoRec, { version: number; byNumber: Map<number, string> }>();

export function issueText(repo: RepoRec, row: RowRec): string {
  let cache = issueTextCache.get(repo);
  if (!cache || cache.version !== repo.rowVersion) {
    cache = { version: repo.rowVersion, byNumber: new Map() };
    issueTextCache.set(repo, cache);
  }
  let text = cache.byNumber.get(row.number);
  if (text === undefined) {
    text = JSON.stringify(issueJson(repo, row));
    cache.byNumber.set(row.number, text);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Merge machinery: three-way per-file merge against the merge-base.
// ---------------------------------------------------------------------------

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(data: Buffer | null): number {
  if (data === null || data.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  return data[data.length - 1] === 0x0a ? count - 1 : count;
}

/** The files that differ between the merge-base tree and the head tree. */
export function changedFiles(repo: RepoRec, baseTip: string, headTip: string): FileChange[] {
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = base ? flattenTree(repo, (commitOf(repo, base) as { tree: string }).tree) : new Map<string, string>();
  const headFlat = flattenTree(repo, (commitOf(repo, headTip) as { tree: string }).tree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before === after) continue;
    const beforeData = before ? (repo.objects.get(before)?.data ?? null) : null;
    const afterData = after ? (repo.objects.get(after)?.data ?? null) : null;
    const additions = after === undefined ? 0 : lineCount(afterData);
    const deletions = before === undefined ? 0 : lineCount(beforeData);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  changes.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return changes;
}

/**
 * Three-way merge of head into base. Returns the merged flat tree, or null on
 * a per-file conflict (both sides changed the same path differently).
 */
export function mergeTrees(repo: RepoRec, baseTip: string, headTip: string): Map<string, string> | null {
  const base = mergeBase(repo, baseTip, headTip);
  const ancestorFlat = base ? flattenTree(repo, (commitOf(repo, base) as { tree: string }).tree) : new Map<string, string>();
  const baseFlat = flattenTree(repo, (commitOf(repo, baseTip) as { tree: string }).tree);
  const headFlat = flattenTree(repo, (commitOf(repo, headTip) as { tree: string }).tree);
  const merged = new Map<string, string>();
  const paths = new Set<string>([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFlat.get(path);
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    if (inHead === ancestor) {
      if (inBase !== undefined) merged.set(path, inBase);
    } else if (inBase === ancestor) {
      if (inHead !== undefined) merged.set(path, inHead);
    } else if (inBase === inHead) {
      if (inBase !== undefined) merged.set(path, inBase);
    } else {
      return null;
    }
  }
  return merged;
}

/** Whether merging head into base would conflict. */
export function mergeWouldConflict(repo: RepoRec, baseTip: string, headTip: string): boolean {
  if (isAncestor(repo, headTip, baseTip)) return false;
  return mergeTrees(repo, baseTip, headTip) === null;
}

/**
 * Merge a pull request row into its base branch (squash by default). Returns
 * { sha } on success, 'conflict' when the merge cannot be made, or 'gone'
 * when a branch has vanished.
 */
export function mergePullRow(repo: RepoRec, row: RowRec, method: string): { sha: string } | 'conflict' | 'gone' {
  const baseTip = repo.refs.get(`refs/heads/${row.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${row.headRef}`);
  if (!baseTip || !headTip) return 'gone';
  if (!isAncestor(repo, headTip, baseTip)) {
    const mergedFlat = mergeTrees(repo, baseTip, headTip);
    if (mergedFlat === null) return 'conflict';
    const tree = buildTreeFromFlat(repo, mergedFlat);
    const line = forgeLine(repo);
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const message = method === 'merge' ? `Merge pull request #${row.number} from ${row.headRef}` : `${row.title} (#${row.number})`;
    const commit = buildCommit(tree, parents, line, line, message);
    const sha = storeObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${row.baseRef}`, sha);
    repo.version += 1;
    row.mergeCommitSha = sha;
  } else {
    row.mergeCommitSha = baseTip;
  }
  row.merged = true;
  row.state = 'closed';
  row.mergedAt = new Date(1_735_689_600_000 + row.id * 61_000).toISOString();
  repo.rowVersion += 1;
  return { sha: row.mergeCommitSha };
}

function forgeLine(repo: RepoRec): string {
  const user = viewer();
  repo.commitClock += 1;
  return `${user.name} <${user.email}> ${1_735_689_600 + repo.commitClock * 61} +0000`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(ex: Exchange, status: number, message: string): void {
  ex.respondJson(status, { message });
}

function repoOr404(ex: Exchange, owner: string, name: string): RepoRec | null {
  const repo = store.repo(owner, name);
  if (!repo) {
    fail(ex, 404, 'Not Found');
    return null;
  }
  return repo;
}

function intParam(ex: Exchange, name: string, fallback: number): number {
  const raw = ex.query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveRefTip(repo: RepoRec, ref: string): string | null {
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip) return branchTip;
  const tagTip = repo.refs.get(`refs/tags/${ref}`);
  if (tagTip) return peelToCommit(repo, tagTip);
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
  if (ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleRepoCreate(ex: Exchange): void {
  const body = ex.jsonBody();
  const name = typeof body?.name === 'string' ? body.name : '';
  if (name === '') return fail(ex, 422, 'Validation Failed');
  const owner = viewer().login;
  if (store.repo(owner, name)) return fail(ex, 422, 'name already exists on this account');
  const repo = store.createRepo(
    owner,
    name,
    typeof body?.description === 'string' ? body.description : '',
    typeof body?.private === 'boolean' ? body.private : false,
  );
  if (typeof body?.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  ex.respondJson(201, repoJson(repo));
}

function handleUserReposList(ex: Exchange): void {
  const owner = viewer().login;
  const mine = [...store.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  const perPage = intParam(ex, 'per_page', 30);
  const page = intParam(ex, 'page', 1);
  const slice = mine.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < mine.length) {
    const next = `http://${ex.host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const last = `http://${ex.host}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(mine.length / perPage)}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  ex.respondJson(200, slice.map(repoJson), headers);
}

function handleContents(ex: Exchange, repo: RepoRec, pathParts: string[]): void {
  const path = pathParts.join('/');
  if (ex.method === 'PUT') {
    const body = ex.jsonBody();
    if (!body || typeof body.content !== 'string' || typeof body.message !== 'string') {
      return fail(ex, 422, 'Validation Failed');
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const content = Buffer.from(body.content, 'base64');
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    const existing = tip ? blobAtPath(repo, tip, path) : null;
    if (existing && typeof body.sha === 'string' && body.sha !== existing.oid) {
      return fail(ex, 409, 'Conflict: the file has changed since the sha was read');
    }
    if (existing && typeof body.sha !== 'string') {
      return fail(ex, 422, 'Validation Failed: sha is required to update a file');
    }
    const fallback = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    const commitSha = commitFileChange(repo, branch, path, content, body.message, fallback);
    const blobSha = storeObject(repo, 'blob', content);
    ex.respondJson(201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message: body.message },
    });
    return;
  }
  if (ex.method === 'DELETE') {
    const body = ex.jsonBody();
    if (!body || typeof body.message !== 'string') return fail(ex, 422, 'Validation Failed');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
    const existing = tip ? blobAtPath(repo, tip, path) : null;
    if (!tip || !existing) return fail(ex, 404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      return fail(ex, 409, 'Conflict: the file has changed since the sha was read');
    }
    const commitSha = commitFileChange(repo, branch, path, null, body.message, tip);
    ex.respondJson(200, { content: null, commit: { sha: commitSha, message: body.message } });
    return;
  }
  // GET
  const ref = ex.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRefTip(repo, ref);
  if (!tip) return fail(ex, 404, 'Not Found');
  const view = commitOf(repo, tip);
  if (!view) return fail(ex, 404, 'Not Found');
  if (path === '') {
    return listTree(ex, repo, view.tree, '');
  }
  // Walk to the target.
  let treeOid = view.tree;
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return fail(ex, 404, 'Not Found');
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return fail(ex, 404, 'Not Found');
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return listTree(ex, repo, entry.oid, path);
      const blob = repo.objects.get(entry.oid);
      if (!blob) return fail(ex, 404, 'Not Found');
      ex.respondJson(200, {
        type: 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
      return;
    }
    if (entry.mode !== '40000') return fail(ex, 404, 'Not Found');
    treeOid = entry.oid;
  }
}

function listTree(ex: Exchange, repo: RepoRec, treeOid: string, prefix: string): void {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return fail(ex, 404, 'Not Found');
  const entries = parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: isDir ? 0 : (blob?.data.length ?? 0),
      type: isDir ? 'dir' : 'file',
    };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  ex.respondJson(200, entries);
}

function handleIssues(ex: Exchange, repo: RepoRec): void {
  if (ex.method === 'POST') {
    const body = ex.jsonBody();
    if (!body || typeof body.title !== 'string' || body.title === '') return fail(ex, 422, 'Validation Failed');
    const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
    for (const name of labels) {
      if (!repo.labels.has(name)) return fail(ex, 422, `Validation Failed: label "${name}" does not exist`);
    }
    const row = store.createRow(repo, 'issue', body.title, typeof body.body === 'string' ? body.body : '');
    row.labels = labels;
    ex.respond(201, issueText(repo, row), JSON_TYPE);
    return;
  }
  // GET list
  const state = ex.query.get('state') ?? 'open';
  const sort = ex.query.get('sort') ?? 'created';
  const direction = ex.query.get('direction') ?? 'desc';
  const perPage = intParam(ex, 'per_page', 30);
  const page = intParam(ex, 'page', 1);
  let rows = [...repo.rows.values()].filter((row) => row.kind === 'issue');
  if (state === 'open' || state === 'closed') rows = rows.filter((row) => row.state === state);
  rows.sort((a, b) => a.number - b.number);
  if (sort === 'created' && direction !== 'asc') rows.reverse();
  const slice = rows.slice((page - 1) * perPage, page * perPage);
  ex.respondJson(200, slice.map((row) => issueJson(repo, row)));
}

function handleIssue(ex: Exchange, repo: RepoRec, number: number): void {
  const row = repo.rows.get(number);
  if (!row) return fail(ex, 404, 'Not Found');
  if (ex.method === 'GET') {
    ex.respond(200, issueText(repo, row), JSON_TYPE);
    return;
  }
  if (ex.method === 'PATCH') {
    const body = ex.jsonBody() ?? {};
    if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) row.state = body.state;
    if (typeof body.title === 'string') row.title = body.title;
    if (typeof body.body === 'string') row.body = body.body;
    if (Array.isArray(body.labels)) {
      const labels = body.labels.filter((x): x is string => typeof x === 'string');
      for (const name of labels) if (!repo.labels.has(name)) return fail(ex, 422, `Validation Failed: label "${name}" does not exist`);
      row.labels = labels;
    }
    repo.rowVersion += 1;
    ex.respond(200, issueText(repo, row), JSON_TYPE);
    return;
  }
  fail(ex, 404, 'Not Found');
}

function handleComments(ex: Exchange, repo: RepoRec, number: number): void {
  const row = repo.rows.get(number);
  if (!row) return fail(ex, 404, 'Not Found');
  if (ex.method === 'POST') {
    const body = ex.jsonBody();
    if (!body || typeof body.body !== 'string') return fail(ex, 422, 'Validation Failed');
    const comment = store.addComment(repo, number, body.body);
    ex.respondJson(201, { id: comment.id, body: comment.body });
    return;
  }
  const list = repo.comments.get(number) ?? [];
  ex.respondJson(200, list.map((comment) => ({ id: comment.id, body: comment.body })));
}

function handlePulls(ex: Exchange, repo: RepoRec): void {
  if (ex.method === 'POST') {
    const body = ex.jsonBody();
    if (!body || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
      return fail(ex, 422, 'Validation Failed');
    }
    const headTip = repo.refs.get(`refs/heads/${body.head}`);
    const baseTip = repo.refs.get(`refs/heads/${body.base}`);
    if (!headTip) return fail(ex, 422, `Validation Failed: head branch "${body.head}" does not exist`);
    if (!baseTip) return fail(ex, 422, `Validation Failed: base branch "${body.base}" does not exist`);
    if (body.head === body.base) return fail(ex, 422, 'Validation Failed: head and base are the same branch');
    if (!isAncestor(repo, baseTip, headTip) && mergeBase(repo, baseTip, headTip) === null) {
      return fail(ex, 422, 'Validation Failed: no common history between head and base');
    }
    if (isAncestor(repo, headTip, baseTip)) {
      return fail(ex, 422, 'Validation Failed: no commits between base and head');
    }
    const duplicate = [...repo.rows.values()].some(
      (row) => row.kind === 'pull' && row.state === 'open' && row.headRef === body.head && row.baseRef === body.base,
    );
    if (duplicate) return fail(ex, 422, 'Validation Failed: a pull request already exists for this branch combination');
    const row = store.createRow(repo, 'pull', body.title, typeof body.body === 'string' ? body.body : '');
    row.headRef = body.head;
    row.baseRef = body.base;
    row.headSha = headTip;
    ex.respondJson(201, pullJson(repo, row));
    return;
  }
  const state = ex.query.get('state') ?? 'open';
  const perPage = intParam(ex, 'per_page', 30);
  const page = intParam(ex, 'page', 1);
  let rows = [...repo.rows.values()].filter((row) => row.kind === 'pull');
  if (state === 'open' || state === 'closed') rows = rows.filter((row) => row.state === state);
  rows.sort((a, b) => a.number - b.number);
  const slice = rows.slice((page - 1) * perPage, page * perPage);
  ex.respondJson(200, slice.map((row) => pullJson(repo, row)));
}

function handlePull(ex: Exchange, repo: RepoRec, number: number, tail: string[]): void {
  const row = repo.rows.get(number);
  if (!row || row.kind !== 'pull') return fail(ex, 404, 'Not Found');
  if (tail.length === 0 && ex.method === 'GET') {
    ex.respondJson(200, pullJson(repo, row));
    return;
  }
  if (tail.length === 1 && tail[0] === 'files' && ex.method === 'GET') {
    const baseTip = repo.refs.get(`refs/heads/${row.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${row.headRef}`) ?? row.headSha;
    if (!baseTip || !headTip) return fail(ex, 404, 'Not Found');
    ex.respondJson(200, changedFiles(repo, baseTip, headTip));
    return;
  }
  if (tail.length === 1 && tail[0] === 'merge' && ex.method === 'PUT') {
    if (row.merged) return fail(ex, 405, 'Pull Request is not mergeable');
    const body = ex.jsonBody() ?? {};
    const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const result = mergePullRow(repo, row, method);
    if (result === 'conflict') return fail(ex, 405, 'Pull Request is not mergeable: conflict');
    if (result === 'gone') return fail(ex, 405, 'Pull Request is not mergeable: a branch is missing');
    ex.respondJson(200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
    return;
  }
  fail(ex, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// The dispatcher for everything under /api/v3 (segments exclude the prefix).
// ---------------------------------------------------------------------------

export function handleRest(ex: Exchange): void {
  const seg = ex.segments;
  // seg[0] === 'api', seg[1] === 'v3'
  const rest = seg.slice(2);

  if (rest.length === 0) {
    if (ex.method === 'GET') {
      ex.respondJson(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    return fail(ex, 404, 'Not Found');
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (ex.method === 'GET') return ex.respondJson(200, { installed_version: '1.0.0' });
    return fail(ex, 404, 'Not Found');
  }

  if (!ex.authed) return fail(ex, 401, 'Requires authentication');

  if ((ex.method === 'POST' || ex.method === 'PUT' || ex.method === 'PATCH' || ex.method === 'DELETE') && ex.body.length > 0 && ex.jsonBody() === null) {
    return fail(ex, 400, 'Problems parsing JSON');
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (ex.method === 'GET') {
      const user = viewer();
      return ex.respondJson(200, { login: user.login, id: user.id, name: user.name, email: user.email, type: 'User' });
    }
    return fail(ex, 404, 'Not Found');
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (ex.method === 'POST') return handleRepoCreate(ex);
    if (ex.method === 'GET') return handleUserReposList(ex);
    return fail(ex, 404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) return fail(ex, 404, 'Not Found');
  const owner = rest[1] as string;
  const name = rest[2] as string;
  const tail = rest.slice(3);
  const repo = repoOr404(ex, owner, name);
  if (!repo) return;

  if (tail.length === 0) {
    if (ex.method === 'GET') return ex.respondJson(200, repoJson(repo));
    if (ex.method === 'PATCH') {
      const body = ex.jsonBody() ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.priv = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        store.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = body.name;
        store.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      return ex.respondJson(200, repoJson(repo));
    }
    if (ex.method === 'DELETE') {
      store.deleteRepo(owner, name);
      ex.respond(204, '');
      return;
    }
    return fail(ex, 404, 'Not Found');
  }

  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (ex.method === 'POST' && tail.length === 2) {
      const body = ex.jsonBody();
      if (!body || typeof body.ref !== 'string' || typeof body.sha !== 'string') return fail(ex, 422, 'Validation Failed');
      const object = repo.objects.get(body.sha);
      if (!object) return fail(ex, 422, 'Validation Failed: object does not exist');
      if (repo.refs.has(body.ref)) return fail(ex, 422, 'Reference already exists');
      repo.refs.set(body.ref, body.sha);
      repo.version += 1;
      return ex.respondJson(201, { ref: body.ref, object: { sha: body.sha, type: object.type } });
    }
    if (ex.method === 'GET' && tail.length > 2) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return fail(ex, 404, 'Not Found');
      const object = repo.objects.get(sha);
      return ex.respondJson(200, { ref, object: { sha, type: object?.type ?? 'commit' } });
    }
    return fail(ex, 404, 'Not Found');
  }

  if (tail[0] === 'branches') {
    if (ex.method === 'GET' && tail.length === 1) {
      const branches: Array<{ name: string; commit: { sha: string } }> = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      branches.sort((a, b) => (a.name < b.name ? -1 : 1));
      return ex.respondJson(200, branches);
    }
    if (ex.method === 'GET' && tail.length > 1) {
      const branch = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return fail(ex, 404, 'Not Found');
      return ex.respondJson(200, { name: branch, commit: { sha } });
    }
    return fail(ex, 404, 'Not Found');
  }

  if (tail[0] === 'commits' && tail.length === 1 && ex.method === 'GET') {
    const ref = ex.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRefTip(repo, ref);
    if (!tip) return ex.respondJson(200, []);
    const list = ancestry(repo, tip).map((sha) => {
      const view = commitOf(repo, sha) as { tree: string; message: string };
      return { sha, commit: { message: view.message, tree: { sha: view.tree } } };
    });
    return ex.respondJson(200, list);
  }

  if (tail[0] === 'contents') {
    return handleContents(ex, repo, tail.slice(1));
  }

  if (tail[0] === 'labels' && tail.length === 1 && ex.method === 'POST') {
    const body = ex.jsonBody();
    if (!body || typeof body.name !== 'string' || body.name === '') return fail(ex, 422, 'Validation Failed');
    if (repo.labels.has(body.name)) return fail(ex, 422, 'Validation Failed: label already exists');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    repo.labels.set(body.name, { name: body.name, color });
    return ex.respondJson(201, { name: body.name, color });
  }

  if (tail[0] === 'issues' && tail.length === 1) return handleIssues(ex, repo);
  if (tail[0] === 'issues' && tail.length === 2) {
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isFinite(number)) return fail(ex, 404, 'Not Found');
    return handleIssue(ex, repo, number);
  }
  if (tail[0] === 'issues' && tail.length === 3 && tail[2] === 'comments') {
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isFinite(number)) return fail(ex, 404, 'Not Found');
    return handleComments(ex, repo, number);
  }

  if (tail[0] === 'pulls' && tail.length === 1) return handlePulls(ex, repo);
  if (tail[0] === 'pulls' && tail.length >= 2) {
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isFinite(number)) return fail(ex, 404, 'Not Found');
    return handlePull(ex, repo, number, tail.slice(2));
  }

  fail(ex, 404, 'Not Found');
}
