// Shared core: the seeded identities the suite addresses, the in-memory store
// every surface reads and writes, and the git object model (hashing, parsing,
// packfiles, pkt-lines) the smart-HTTP surface is built on.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Seeded identity. The suite derives its users from one fixed seed with a
// splitmix-flavoured xorshift stream; the forge must resolve the same viewer
// login (the token's owner) with no other channel, so the derivation is
// reproduced here exactly: FNV-1a label hash, splitmix64 finalizer, and an
// xorshift64* stream picking first/last names from the same lists.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function scenarioRng(label: string): Rng {
  return new Rng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ForgeUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

function generateUsers(rng: Rng, count: number): ForgeUser[] {
  const used = new Set<string>();
  const users: ForgeUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

let cachedUsers: ForgeUser[] | null = null;

/** The suite's twelve users; index 0 is the viewer (the token's owner). */
export function forgeUsers(): ForgeUser[] {
  if (cachedUsers === null) cachedUsers = generateUsers(scenarioRng('users'), 12);
  return cachedUsers;
}

export function viewer(): ForgeUser {
  return forgeUsers()[0] as ForgeUser;
}

// ---------------------------------------------------------------------------
// Git object model
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  let start = 0;
  while (start < headerEnd) {
    let end = data.indexOf(0x0a, start);
    if (end < 0 || end > headerEnd) end = headerEnd;
    const line = data.subarray(start, end).toString('utf8');
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
    start = end + 1;
  }
  return view;
}

export function buildCommit(tree: string, parents: readonly string[], authorLine: string, committerLine: string, message: string): Buffer {
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${authorLine}\ncommitter ${committerLine}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(message, 'utf8')]);
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: TagView = { object: '', type: '', tag: '' };
  let start = 0;
  while (start < headerEnd) {
    let end = data.indexOf(0x0a, start);
    if (end < 0 || end > headerEnd) end = headerEnd;
    const line = data.subarray(start, end).toString('utf8');
    const space = line.indexOf(' ');
    if (space < 0) break;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') view.object = value;
    else if (key === 'type') view.type = value;
    else if (key === 'tag') view.tag = value;
    start = end + 1;
  }
  return view;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Packfiles: plain objects only on write (no deltas); ofs/ref deltas resolved
// on read so any client's pack is accepted.
// ---------------------------------------------------------------------------

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A packfile (version 2) holding `objects` in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** An empty packfile: header plus trailer, 32 bytes. */
export function emptyPack(): Buffer {
  return writePack([]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readSize();
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return out;
}

interface RawPackEntry {
  typeCode: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
  offset: number;
}

/** Parse a packfile into resolved objects. Throws on any structural problem. */
export function readPack(pack: Buffer): GitObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawPackEntry = { typeCode, data: Buffer.alloc(0), baseOffset: -1, baseOid: '', offset: entryOffset };
    if (typeCode === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');
  const resolved = new Map<number, GitObject>();
  const resolve = (entry: RawPackEntry): GitObject => {
    const hit = resolved.get(entry.offset);
    if (hit) return hit;
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      throw new Error('ref-delta against an external base is not accepted here');
    } else {
      const type = CODE_TYPE[entry.typeCode];
      if (!type) throw new Error(`unknown pack type code ${entry.typeCode}`);
      object = { type, data: entry.data };
    }
    resolved.set(entry.offset, object);
    return object;
  };
  return raw.map(resolve);
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a complete pkt-line stream; throws on malformed framing. */
export function decodePktLines(bytes: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error('invalid pkt-line length');
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface LabelRec {
  name: string;
  color: string;
}

export interface RowRec {
  id: number;
  number: number;
  kind: 'issue' | 'pull';
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  headRef: string;
  baseRef: string;
  headSha: string;
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  rows: Map<number, RowRec>;
  rowSeq: number;
  comments: Map<number, CommentRec[]>;
  /** Bump on any git-visible change; caches key off it. */
  version: number;
  /** Bump on any row change; serialized-body caches key off it. */
  rowVersion: number;
  commitClock: number;
  commitCache: Map<string, CommitView>;
  packCache: Map<string, Buffer>;
  lsRefsCache: Map<string, Buffer>;
}

export class Store {
  readonly repos = new Map<string, RepoRec>();
  readonly reposById = new Map<number, RepoRec>();
  repoSeq = 0;
  issueSeq = 0;
  commentSeq = 0;
  requestSeq = 0;

  createRepo(owner: string, name: string, description: string, priv: boolean): RepoRec {
    this.repoSeq += 1;
    const repo: RepoRec = {
      id: this.repoSeq,
      owner,
      name,
      description,
      priv,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      rows: new Map(),
      rowSeq: 0,
      comments: new Map(),
      version: 0,
      rowVersion: 0,
      commitClock: 0,
      commitCache: new Map(),
      packCache: new Map(),
      lsRefsCache: new Map(),
    };
    this.repos.set(`${owner}/${name}`, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  repo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repo(owner, name);
    if (!repo) return false;
    this.repos.delete(`${owner}/${name}`);
    this.reposById.delete(repo.id);
    return true;
  }

  createRow(repo: RepoRec, kind: 'issue' | 'pull', title: string, body: string): RowRec {
    this.issueSeq += 1;
    repo.rowSeq += 1;
    const row: RowRec = {
      id: this.issueSeq,
      number: repo.rowSeq,
      kind,
      title,
      body,
      state: 'open',
      labels: [],
      headRef: '',
      baseRef: '',
      headSha: '',
      merged: false,
      mergedAt: '',
      mergeCommitSha: '',
    };
    repo.rows.set(row.number, row);
    repo.rowVersion += 1;
    return row;
  }

  addComment(repo: RepoRec, rowNumber: number, body: string): CommentRec {
    this.issueSeq += 1;
    const comment: CommentRec = { id: this.issueSeq, body };
    const list = repo.comments.get(rowNumber);
    if (list) list.push(comment);
    else repo.comments.set(rowNumber, [comment]);
    return comment;
  }
}

/** The one store instance every surface shares. */
export const store = new Store();

// ---------------------------------------------------------------------------
// Repository git helpers (shared by REST, GraphQL, MCP and smart HTTP)
// ---------------------------------------------------------------------------

export function storeObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function commitOf(repo: RepoRec, oid: string): CommitView | null {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  repo.commitCache.set(oid, view);
  return view;
}

/** Peel an object id to its commit (through annotated tags), or null. */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Every object reachable from `roots`, parents and trees included. */
export function reachableObjects(repo: RepoRec, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Commit ids reachable from `tip`, newest first (depth-first, parents in order). */
export function ancestry(repo: RepoRec, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const view = commitOf(repo, oid);
    if (!view) continue;
    seen.add(oid);
    order.push(oid);
    for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
  }
  return order;
}

export function isAncestor(repo: RepoRec, ancestor: string, tip: string): boolean {
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

/** The best common ancestor of two commits, or null. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const fromA = new Set(ancestry(repo, a));
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const view = commitOf(repo, oid);
    if (!view) continue;
    for (const parent of view.parents) queue.push(parent);
  }
  return null;
}

/** Flatten a tree (recursively) to path -> blob oid. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/** Build nested trees from a flat path -> blob oid map; returns the root tree oid. */
export function buildTreeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = node.dirs.get(segment);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The blob bytes at `path` in the tree of commit `tip`, or null. */
export function blobAtPath(repo: RepoRec, tip: string, path: string): { oid: string; data: Buffer } | null {
  const view = commitOf(repo, tip);
  if (!view) return null;
  let treeOid = view.tree;
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const blob = repo.objects.get(entry.oid);
      if (!blob || blob.type !== 'blob') return null;
      return { oid: entry.oid, data: blob.data };
    }
    treeOid = entry.oid;
  }
  return null;
}

/** A deterministic synthetic timestamp for commits the forge itself creates. */
export function forgeTimestamp(repo: RepoRec): number {
  repo.commitClock += 1;
  return 1_735_689_600 + repo.commitClock * 61;
}

export function authorLine(repo: RepoRec): string {
  const user = viewer();
  return `${user.name} <${user.email}> ${forgeTimestamp(repo)} +0000`;
}

/**
 * Create a commit on `branch` that sets `path` to `content` (or removes it when
 * `content` is null), building on the branch tip (or the fallback tip when the
 * branch does not exist yet). Returns the new commit oid.
 */
export function commitFileChange(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
  fallbackTip: string | null,
): string {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName) ?? fallbackTip;
  const flat = new Map<string, string>();
  if (tip) {
    const view = commitOf(repo, tip);
    if (view) flattenTree(repo, view.tree, '', flat);
  }
  if (content === null) flat.delete(path);
  else flat.set(path, storeObject(repo, 'blob', content));
  const tree = buildTreeFromFlat(repo, flat);
  const line = authorLine(repo);
  const commit = buildCommit(tree, tip ? [tip] : [], line, line, message);
  const oid = storeObject(repo, 'commit', commit);
  repo.refs.set(refName, oid);
  repo.version += 1;
  return oid;
}
