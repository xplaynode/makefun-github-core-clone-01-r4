// Git smart HTTP: info/refs advertisements (v0 and v2), the v2 ls-refs and
// fetch commands, v0 fetch, and receive-pack pushes with report-status over
// side-band-64k. Repeated answers (advertisements, ls-refs listings, clone
// packs) are cached against the repository's version counter.

import {
  PKT_FLUSH,
  ZERO_OID,
  commitOf,
  decodePktLines,
  emptyPack,
  hashObject,
  parseTag,
  parseTree,
  pktLine,
  reachableObjects,
  readPack,
  store,
  writePack,
  type GitObject,
  type RepoRec,
} from './core.ts';

export interface SmartExchange {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  header(name: string): string | null;
  respond(status: number, body: string | Buffer, contentType?: string, headers?: Record<string, string>): void;
  respondJson(status: number, value: unknown, headers?: Record<string, string>): void;
}

const AGENT = 'lucky-forge/1.0.0';
const ZERO = ZERO_OID;

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('fetch=shallow\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

const adCache = new WeakMap<RepoRec, { version: number; upload: Buffer; receive: Buffer }>();
const versionSeen = new WeakMap<RepoRec, number>();

function refreshCaches(repo: RepoRec): void {
  if (versionSeen.get(repo) !== repo.version) {
    versionSeen.set(repo, repo.version);
    repo.packCache.clear();
    repo.lsRefsCache.clear();
  }
}

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cached = adCache.get(repo);
  if (cached && cached.version === repo.version) {
    return service === 'git-upload-pack' ? cached.upload : cached.receive;
  }
  const build = (forService: 'git-upload-pack' | 'git-receive-pack', caps: string): Buffer => {
    const parts: Buffer[] = [pktLine(`# service=${forService}\n`), PKT_FLUSH];
    const refs = sortedRefs(repo);
    const headTarget = `refs/heads/${repo.defaultBranch}`;
    const headTip = repo.refs.get(headTarget);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
      return Buffer.concat(parts);
    }
    let first = true;
    const line = (oid: string, name: string): void => {
      if (first) {
        parts.push(pktLine(`${oid} ${name}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${oid} ${name}\n`));
      }
    };
    line(headTip ?? ZERO, 'HEAD');
    for (const [name, oid] of refs) {
      line(oid, name);
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const target = parseTag(object.data).object;
        parts.push(pktLine(`${target} ${name}^{}\n`));
      }
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  };
  const upload = build('git-upload-pack', `side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`);
  const receive = build('git-receive-pack', `agent=${AGENT} delete-refs ofs-delta report-status side-band-64k`);
  adCache.set(repo, { version: repo.version, upload, receive });
  return service === 'git-upload-pack' ? upload : receive;
}

// ---------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: RepoRec, args: LsRefsArgs): Buffer {
  const key = `${args.peel ? 'p' : ''}${args.symrefs ? 's' : ''}|${args.prefixes.join(',')}`;
  const cached = repo.lsRefsCache.get(key);
  if (cached) return cached;
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headTarget);
  const includeHead = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (includeHead) {
    const suffix = args.symrefs ? ` symref-target:${headTarget}` : '';
    parts.push(pktLine(headTip ? `${headTip} HEAD${suffix}\n` : `unborn HEAD${suffix}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  repo.lsRefsCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Fetch: object selection with have-exclusion and shallow depth limits
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  deepen: number | null;
  done: boolean;
}

interface FetchSelection {
  objects: GitObject[];
  boundary: string[];
  unshallow: string[];
  shallowMode: boolean;
}

/** Objects reachable from `root` without following the root commit's parents. */
function closureCutAt(repo: RepoRec, root: string, into: Set<string>): void {
  const object = repo.objects.get(root);
  if (!object) return;
  if (object.type !== 'commit') {
    for (const oid of reachableObjects(repo, [root])) into.add(oid);
    return;
  }
  // The commit itself plus its full tree closure, but not its ancestry.
  const view = commitOf(repo, root);
  if (!view) return;
  into.add(root);
  for (const oid of reachableObjects(repo, [view.tree])) into.add(oid);
}

function selectFetchObjects(repo: RepoRec, request: FetchRequest): FetchSelection {
  const shallowSet = new Set(request.shallowLines);
  const excluded = new Set<string>();
  for (const have of request.haves) {
    if (shallowSet.has(have)) closureCutAt(repo, have, excluded);
    else for (const oid of reachableObjects(repo, [have])) excluded.add(oid);
  }
  const shallowMode = request.deepen !== null || request.shallowLines.length > 0;
  const depthLimit = request.deepen ?? Number.POSITIVE_INFINITY;

  const included = new Set<string>();
  const commitDepth = new Map<string, number>();
  // Breadth-first by commit depth so depth limits cut whole generations.
  let frontier: string[] = [];
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      // Include the tag chain down to its commit.
      let current = want;
      while (true) {
        const currentObject = repo.objects.get(current);
        if (!currentObject) break;
        if (!excluded.has(current)) included.add(current);
        if (currentObject.type === 'tag') {
          current = parseTag(currentObject.data).object;
          continue;
        }
        if (currentObject.type === 'commit' && !frontier.includes(current)) frontier.push(current);
        break;
      }
    } else if (object.type === 'commit') {
      if (!frontier.includes(want)) frontier.push(want);
    } else if (!excluded.has(want)) {
      included.add(want);
    }
  }
  let depth = 1;
  const includedCommits: string[] = [];
  const queued = new Set<string>(frontier);
  while (frontier.length) {
    const next: string[] = [];
    for (const oid of frontier) {
      const view = commitOf(repo, oid);
      if (!view) continue;
      const held = excluded.has(oid);
      if (!held && !included.has(oid) && depth <= depthLimit) {
        included.add(oid);
        includedCommits.push(oid);
        commitDepth.set(oid, depth);
        for (const oid2 of reachableObjects(repo, [view.tree])) {
          if (!excluded.has(oid2)) included.add(oid2);
        }
      }
      // Walk on through included commits, and through commits the client
      // holds only shallowly (their parents are not held). Fully held
      // commits end the walk: everything behind them is held too. Past the
      // depth limit nothing more can be included, so the walk stops there
      // unless a shallow-held commit must be walked through.
      if ((!held && depth <= depthLimit) || shallowSet.has(oid)) {
        for (const parent of view.parents) {
          if (!queued.has(parent)) {
            queued.add(parent);
            next.push(parent);
          }
        }
      }
    }
    frontier = next;
    depth += 1;
  }

  const boundary: string[] = [];
  const unshallow: string[] = [];
  if (shallowMode) {
    const clientHas = new Set<string>([...excluded, ...request.shallowLines]);
    for (const oid of includedCommits) {
      const view = commitOf(repo, oid);
      if (!view || view.parents.length === 0) continue;
      const atLimit = commitDepth.get(oid) === depthLimit;
      const parentCut = view.parents.some((parent) => !included.has(parent) && !clientHas.has(parent));
      const parentShallow = view.parents.some((parent) => shallowSet.has(parent));
      if (atLimit || parentCut || parentShallow) boundary.push(oid);
    }
    for (const line of request.shallowLines) {
      if (boundary.includes(line)) continue;
      const view = commitOf(repo, line);
      if (!view || view.parents.length === 0) continue;
      // A formerly shallow commit whose parents are now delivered in full is
      // no longer shallow.
      if (view.parents.some((parent) => included.has(parent))) unshallow.push(line);
    }
  }

  // Pack order: commits first in walk order, then each commit's tree closure
  // in depth-first pre-order, then anything else that was included.
  const emitted = new Set<string>();
  const objects: GitObject[] = [];
  const emit = (oid: string): void => {
    if (!included.has(oid) || emitted.has(oid)) return;
    emitted.add(oid);
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  };
  for (const oid of includedCommits) emit(oid);
  const emitTree = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (!object) return;
    emit(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) emitTree(entry.oid);
    }
  };
  for (const oid of includedCommits) {
    const view = commitOf(repo, oid);
    if (view) emitTree(view.tree);
  }
  for (const oid of included) emit(oid);
  return { objects, boundary, unshallow, shallowMode };
}

function fetchPack(repo: RepoRec, request: FetchRequest, selection: FetchSelection): Buffer {
  const key = [
    'f',
    request.wants.join(','),
    request.haves.join(','),
    request.shallowLines.join(','),
    String(request.deepen),
  ].join('|');
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const pack = selection.objects.length === 0 ? emptyPack() : writePack(selection.objects);
  repo.packCache.set(key, pack);
  return pack;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.allocUnsafe(slice.length + 1);
    payload[0] = 1;
    slice.copy(payload, 1);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function fetchCacheKey(prefix: string, request: FetchRequest): string {
  return [
    prefix,
    request.wants.join(','),
    request.haves.join(','),
    request.shallowLines.join(','),
    String(request.deepen),
    request.done ? '1' : '0',
  ].join('|');
}

function fetchResponse(repo: RepoRec, request: FetchRequest): Buffer {
  const cacheKey = fetchCacheKey('R', request);
  const hit = repo.packCache.get(cacheKey);
  if (hit) return hit;
  const response = buildFetchResponse(repo, request);
  repo.packCache.set(cacheKey, response);
  return response;
}

function buildFetchResponse(repo: RepoRec, request: FetchRequest): Buffer {
  const selection = selectFetchObjects(repo, request);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const common = request.haves.filter((have) => repo.objects.has(have));
    if (common.length > 0) {
      parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
      if (request.done) parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
    if (!request.done) return Buffer.concat(parts);
  }
  if (selection.shallowMode && (selection.boundary.length > 0 || selection.unshallow.length > 0)) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  const pack = fetchPack(repo, request, selection);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/** Split a pkt-line stream into (command section, argument section, rest offset). */
function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const commandLines: string[] = [];
  const argLines: string[] = [];
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = 1;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) commandLines.push(text);
    else argLines.push(text);
  }
  const commandLine = commandLines.find((line) => line.startsWith('command='));
  if (!commandLine) return null;
  return { command: commandLine.slice('command='.length), args: argLines };
}

function parseFetchArgs(args: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallowLines: [], deepen: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallowLines.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.deepen = Number.parseInt(arg.slice(7), 10);
    else if (arg === 'done') request.done = true;
  }
  if (request.deepen !== null && !Number.isFinite(request.deepen)) request.deepen = null;
  return request;
}

function parseLsRefsArgs(args: string[]): LsRefsArgs {
  const out: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
  for (const arg of args) {
    if (arg === 'peel') out.peel = true;
    else if (arg === 'symrefs') out.symrefs = true;
    else if (arg.startsWith('ref-prefix ')) out.prefixes.push(arg.slice('ref-prefix '.length));
  }
  return out;
}

/** A v0 fetch: want lines, flush, have lines and done, flush. */
function parseV0Fetch(body: Buffer): FetchRequest | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const request: FetchRequest = { wants: [], haves: [], shallowLines: [], deepen: null, done: false };
  let negotiation = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      negotiation = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!negotiation) {
      if (text.startsWith('want ')) request.wants.push(text.slice(5, 45));
      else if (text.startsWith('shallow ')) request.shallowLines.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) request.deepen = Number.parseInt(text.slice(7), 10);
    } else {
      if (text.startsWith('have ')) request.haves.push(text.slice(5, 45));
      else if (text === 'done') request.done = true;
    }
  }
  if (request.wants.length === 0) return null;
  request.done = true;
  return request;
}

function v0FetchResponse(repo: RepoRec, request: FetchRequest): Buffer {
  const cacheKey = fetchCacheKey('V', request);
  const hit = repo.packCache.get(cacheKey);
  if (hit) return hit;
  const response = buildV0FetchResponse(repo, request);
  repo.packCache.set(cacheKey, response);
  return response;
}

function buildV0FetchResponse(repo: RepoRec, request: FetchRequest): Buffer {
  const selection = selectFetchObjects(repo, request);
  const parts: Buffer[] = [];
  const common = request.haves.filter((have) => repo.objects.has(have));
  parts.push(pktLine(common.length > 0 ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
  for (const oid of selection.boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = fetchPack(repo, request, selection);
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ex: SmartExchange, repo: RepoRec): void {
  const body = ex.body;
  // Walk the command pkt-lines by hand: the pack that follows is raw bytes.
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let offset = 0;
  let parsed = true;
  while (offset < body.length) {
    if (offset + 4 > body.length) {
      parsed = false;
      break;
    }
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      parsed = false;
      break;
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) {
      parsed = false;
      break;
    }
    let text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    if (commands.length === 0 && text.includes('\0')) {
      const [command, caps] = text.split('\0') as [string, string];
      text = command;
      capabilities = new Set(caps.split(' ').filter(Boolean).map((token) => token.split('=')[0] as string));
    }
    const fields = text.split(' ');
    if (fields.length === 3) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
    }
  }
  if (!parsed) {
    ex.respond(400, 'invalid receive-pack request', 'text/plain; charset=utf-8');
    return;
  }
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const object of objects) {
        const oid = hashObject(object.type, object.data);
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let changed = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO;
    const refuse = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      refuse('unpack failed');
      continue;
    }
    if (command.oldOid !== current) {
      refuse(command.oldOid === ZERO ? 'reference already exists' : 'stale info');
      continue;
    }
    if (command.newOid === ZERO) {
      repo.refs.delete(command.ref);
      changed = true;
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      refuse('bad object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
      refuse('bad object');
      continue;
    }
    if (command.oldOid !== ZERO) {
      // Fast-forward only: the old tip must be an ancestor of the new one.
      const newCommit = target.type === 'commit' ? command.newOid : null;
      if (newCommit === null || !isAncestorOf(repo, command.oldOid, newCommit)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    changed = true;
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (changed || packBytes.length > 0) repo.version += 1;

  const reportParts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack index-pack failed\n')];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (capabilities.has('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let at = 0; at < report.length; at += CHUNK) {
      const slice = report.subarray(at, Math.min(at + CHUNK, report.length));
      const payload = Buffer.allocUnsafe(slice.length + 1);
      payload[0] = 1;
      slice.copy(payload, 1);
      parts.push(pktLine(payload));
    }
    parts.push(PKT_FLUSH);
    ex.respond(200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
  } else {
    ex.respond(200, report, 'application/x-git-receive-pack-result');
  }
}

function isAncestorOf(repo: RepoRec, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const view = commitOf(repo, oid);
    if (!view) continue;
    for (const parent of view.parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dispatcher: /<owner>/<repo>.git/...
// ---------------------------------------------------------------------------

export function handleSmart(ex: SmartExchange): void {
  const seg = ex.segments;
  const owner = seg[0] as string;
  const repoSegment = seg[1] as string;
  const name = repoSegment.endsWith('.git') ? repoSegment.slice(0, -4) : repoSegment;
  const repo = store.repo(owner, name);

  if (seg.length === 4 && seg[2] === 'info' && seg[3] === 'refs' && ex.method === 'GET') {
    const service = ex.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      ex.respondJson(404, { message: 'Not Found' });
      return;
    }
    if (!repo) {
      ex.respondJson(404, { message: 'Not Found' });
      return;
    }
    refreshCaches(repo);
    if (service === 'git-upload-pack') {
      const protocol = ex.header('git-protocol') ?? '';
      if (protocol.includes('version=2')) {
        ex.respond(200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
        return;
      }
    }
    ex.respond(200, v0Advertisement(repo, service), `application/x-${service}-advertisement`);
    return;
  }

  if (seg.length === 3 && seg[2] === 'git-upload-pack' && ex.method === 'POST') {
    if (!repo) {
      ex.respondJson(404, { message: 'Not Found' });
      return;
    }
    refreshCaches(repo);
    const v2 = parseV2Request(ex.body);
    if (v2) {
      if (v2.command === 'ls-refs') {
        ex.respond(200, lsRefsResponse(repo, parseLsRefsArgs(v2.args)), 'application/x-git-upload-pack-result');
        return;
      }
      if (v2.command === 'fetch') {
        ex.respond(200, fetchResponse(repo, parseFetchArgs(v2.args)), 'application/x-git-upload-pack-result');
        return;
      }
      ex.respond(400, 'unknown command', 'text/plain; charset=utf-8');
      return;
    }
    const v0 = parseV0Fetch(ex.body);
    if (v0) {
      ex.respond(200, v0FetchResponse(repo, v0), 'application/x-git-upload-pack-result');
      return;
    }
    ex.respond(400, 'invalid upload-pack request', 'text/plain; charset=utf-8');
    return;
  }

  if (seg.length === 3 && seg[2] === 'git-receive-pack' && ex.method === 'POST') {
    if (!repo) {
      ex.respondJson(404, { message: 'Not Found' });
      return;
    }
    handleReceivePack(ex, repo);
    return;
  }

  ex.respondJson(404, { message: 'Not Found' });
}
