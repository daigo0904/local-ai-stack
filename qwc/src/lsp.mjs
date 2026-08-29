// 言語サーバー（LSP）とのやりとり。
//
// ■ なぜ要るのか
//     search_files は文字列の一致しか見ない。`sum` を探すと `sum` `checksum` `sumUp`
//     コメント・文字列リテラルまで全部当たる。そこから本物を選ぶのはモデルの仕事になり、
//     小さいモデルほどここで転ぶ。
//     言語サーバーは「この名前が何を指すか」を意味で知っているので、
//     定義1つと、本当の参照だけを返せる。往復が減り、間違いも減る。
//
// ■ 依存は増やさない
//     LSP は「Content-Length ヘッダ ＋ JSON」を標準入出力でやりとりするだけの決まりごと。
//     ライブラリは要らないので、ここに素で書いてある。
//
// ■ 言語サーバーが無くてもよい
//     入っていなければ道具そのものを渡さない。Playwright と同じ扱い。

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * 拡張子と、その言語のサーバー。
 *
 * `cmd` が PATH に無ければ、その言語は使えないものとして黙って諦める。
 */
const SERVERS = [
  {
    id: 'typescript',
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    cmd: 'typescript-language-server',
    args: ['--stdio'],
    languageId: (ext) => (ext.includes('ts') ? 'typescript' : 'javascript'),
    install: 'npm i -g typescript-language-server typescript',
    // TypeScript 本体は、作業フォルダの node_modules に無ければ見つけてもらえない。
    // 依存ゼロの JS プロジェクトで使うことが多いので、
    // グローバルに入っているものの場所を教えてやる。
    initializationOptions: (root) => {
      const lib = typeScriptLibFor(root);
      return lib ? { tsserver: { path: path.join(lib, 'tsserver.js') } } : {};
    }
  },
  {
    id: 'rust',
    exts: ['.rs'],
    cmd: 'rust-analyzer',
    args: [],
    languageId: () => 'rust',
    install: 'rustup component add rust-analyzer'
  },
  {
    id: 'clangd',
    exts: ['.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm'],
    cmd: 'clangd',
    args: ['--log=error'],
    languageId: () => 'cpp',
    install: 'brew install llvm'
  },
  {
    id: 'python',
    exts: ['.py', '.pyi'],
    cmd: 'pyright-langserver',
    args: ['--stdio'],
    languageId: () => 'python',
    install: 'npm i -g pyright'
  },
  {
    id: 'go',
    exts: ['.go'],
    cmd: 'gopls',
    args: [],
    languageId: () => 'go',
    install: 'go install golang.org/x/tools/gopls@latest'
  }
];

/**
 * TypeScript 本体（tsserver.js）の場所。
 *
 * 探す順番に意味がある。
 *   1. 作業フォルダの node_modules … そのプロジェクトが使っている版に合わせる
 *   2. qwc 自身の node_modules     … 依存ゼロのプロジェクトでも動くように同梱してある
 *
 * グローバルは見に行かない。**TypeScript 7 で tsserver.js が廃止された**ため、
 * 新しいものが入っていると、あるように見えて動かない。
 */
let cachedTsLib = new Map();
function typeScriptLibFor(root) {
  if (cachedTsLib.has(root)) return cachedTsLib.get(root);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(root, 'node_modules/typescript/lib'),
    path.join(here, '..', 'node_modules/typescript/lib')
  ];
  const hit =
    candidates.find((p) => {
      try {
        return fs.existsSync(path.join(p, 'tsserver.js'));
      } catch {
        return false;
      }
    }) || null;
  cachedTsLib.set(root, hit);
  return hit;
}

const which = (cmd) => {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* 次を見る */
    }
  }
  return null;
};

const availability = new Map();
function serverFor(ext) {
  const def = SERVERS.find((s) => s.exts.includes(ext.toLowerCase()));
  if (!def) return null;
  if (!availability.has(def.id)) availability.set(def.id, which(def.cmd));
  return availability.get(def.id) ? { ...def, bin: availability.get(def.id) } : null;
}

/** どれか1つでも言語サーバーが入っているか（道具を渡すかの判断に使う） */
export function anyServerAvailable() {
  return SERVERS.some((s) => {
    if (!availability.has(s.id)) availability.set(s.id, which(s.cmd));
    return Boolean(availability.get(s.id));
  });
}

/** 入っているサーバーと、入っていないものの入れ方 */
export function serverStatus() {
  return SERVERS.map((s) => {
    if (!availability.has(s.id)) availability.set(s.id, which(s.cmd));
    return { id: s.id, exts: s.exts, ready: Boolean(availability.get(s.id)), install: s.install };
  });
}

// ---------------------------------------------------------------------------
// 1つの言語サーバーとの接続
// ---------------------------------------------------------------------------

class Connection {
  constructor(def, root) {
    this.def = def;
    this.root = root;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.opened = new Set();
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.child = spawn(this.def.bin, this.def.args, {
        cwd: this.root,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.child.stdout.on('data', (chunk) => this.onData(chunk));
      this.child.stderr.on('data', () => {
        /* サーバーの雑多なログは捨てる。画面に出しても利用者には意味がない */
      });
      this.child.on('exit', () => {
        for (const { reject } of this.pending.values()) {
          reject(new Error('language server exited'));
        }
        this.pending.clear();
        this.child = null;
        this.ready = null;
      });

      await this.request('initialize', {
        processId: process.pid,
        initializationOptions: this.def.initializationOptions
          ? this.def.initializationOptions(this.root)
          : {},
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
        capabilities: {
          workspace: { symbol: { dynamicRegistration: false } },
          textDocument: {
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            hover: { dynamicRegistration: false, contentFormat: ['plaintext', 'markdown'] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true }
          }
        }
      });
      this.notify('initialized', {});
    })();
    return this.ready;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const header = this.buffer.indexOf('\r\n\r\n');
      if (header < 0) return;
      const head = this.buffer.subarray(0, header).toString('ascii');
      const match = head.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // 読めないヘッダは捨てて先へ進む（ここで止まると以後ずっと動かない）
        this.buffer = this.buffer.subarray(header + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = header + 4;
      if (this.buffer.length < start + length) return; // まだ全部届いていない
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || 'lsp error')) : resolve(msg.result);
      }
    }
  }

  send(payload) {
    if (!this.child?.stdin.writable) return;
    const body = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} が時間内に返りませんでした`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** 問い合わせる前に、そのファイルをサーバーへ渡しておく */
  open(abs) {
    if (this.opened.has(abs)) return;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return;
    }
    this.opened.add(abs);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(abs).href,
        languageId: this.def.languageId(path.extname(abs)),
        version: 1,
        text
      }
    });
  }

  stop() {
    try {
      this.child?.kill();
    } catch {
      /* すでに終わっている */
    }
  }
}

const connections = new Map();

function connectionFor(abs, root) {
  const def = serverFor(path.extname(abs));
  if (!def) return null;
  const key = `${def.id}:${root}`;
  if (!connections.has(key)) connections.set(key, new Connection(def, root));
  return connections.get(key);
}

/** 終了時に後片付けする */
export function stopAll() {
  for (const conn of connections.values()) conn.stop();
  connections.clear();
}

// ---------------------------------------------------------------------------
// 名前から場所を割り出す
// ---------------------------------------------------------------------------

/**
 * 名前で書かれた場所を探す。
 *
 * モデルに行番号と桁を数えさせるのは無理がある（1文字ずれると別物を指す）。
 * だから受け取るのは名前だけにして、位置の特定はこちら側でやる。
 */
async function locateSymbol(name, root, hintFile) {
  // 1. 「定義そのもの」を本文から先に当てる。
  //
  //    workspace/symbol を先に使うと、`import { renderTodos } from ...` のような
  //    取り込み行を拾ってしまい、そこを起点にすると参照が1件しか出ない。
  //    `export function renderTodos(` のような定義の形を先に探したほうが、確実に本体を指せる。
  const found = grepDefinition(name, root, hintFile);
  const seed = found?.file || hintFile || firstSourceFile(root);
  if (!seed) return null;

  const conn = connectionFor(seed, root);
  if (!conn) return null;
  await conn.start();

  // 参照はサーバーが知っているファイルからしか出てこない。
  // 先にプロジェクトのソースを渡しておかないと、取りこぼす。
  primeProject(conn, root, seed);

  if (found) {
    return {
      uri: pathToFileURL(found.file).href,
      position: { line: found.line, character: found.character },
      conn,
      name
    };
  }

  // 2. 定義の形が見つからなければ、言語サーバーに聞く
  try {
    const symbols = await conn.request('workspace/symbol', { query: name });
    const hit = (symbols || []).find((s) => s.name === name) || (symbols || [])[0];
    const loc = hit?.location || hit;
    if (loc?.uri && loc.range) {
      return { uri: loc.uri, position: loc.range.start, conn, name: hit.name || name };
    }
  } catch {
    /* このサーバーは workspace/symbol を持っていない */
  }
  return null;
}

/**
 * プロジェクトのソースをサーバーに渡しておく。
 *
 * tsconfig の無いプロジェクトでは、サーバーは「開かれたファイル」しか見ない。
 * 参照検索が1件しか返らなかったのはこれが原因だった。
 */
function primeProject(conn, root, seed) {
  if (conn.primed) return;
  conn.primed = true;
  const sameKind = collectSources(root).filter(
    (f) => path.extname(f).toLowerCase() === path.extname(seed).toLowerCase() ||
      conn.def.exts.includes(path.extname(f).toLowerCase())
  );
  for (const f of sameKind.slice(0, 200)) conn.open(f);
}

/** 走査の起点にするソースファイルを1つ選ぶ */
function firstSourceFile(root, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) dirs.push(full);
    else if (serverFor(path.extname(e.name))) return full;
  }
  if (depth >= 3) return null;
  for (const d of dirs) {
    const hit = firstSourceFile(d, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * コメントらしい行か。
 *
 * 定義を探すときにコメントを読むと、説明文に書かれたコード例を
 * 本物の定義だと思い込む（このファイル自身のコメントで実際に起きた）。
 * 完全な構文解析はしない。行頭の印だけ見れば、実害のあるものはほぼ防げる。
 */
export function looksLikeComment(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');
}

/** 本文から、その名前が定義されていそうな場所を探す */
function grepDefinition(name, root, hintFile) {
  const n = escapeRe(name);
  // 定義の形。`export function X` `const X = (` `fn X` `def X` など。
  const wanted = new RegExp(
    `\\b(function|class|const|let|var|fn|def|struct|enum|interface|type)\\s+${n}\\b|\\b${n}\\s*[:=]\\s*(function|\\(|async)`
  );
  const files = hintFile ? [hintFile] : collectSources(root);

  for (const file of files) {
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (looksLikeComment(lines[i])) continue;
      if (wanted.test(lines[i])) {
        return { file, line: i, character: Math.max(0, lines[i].indexOf(name)) };
      }
    }
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectSources(root, depth = 0, out = []) {
  if (out.length > 800 || depth > 5) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target' || e.name === 'dist') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) collectSources(full, depth + 1, out);
    else if (serverFor(path.extname(e.name))) out.push(full);
    if (out.length > 800) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 外向きの操作
// ---------------------------------------------------------------------------

function relFromUri(uri, root) {
  try {
    return path.relative(root, fileURLToPath(uri)) || path.basename(fileURLToPath(uri));
  } catch {
    return uri;
  }
}

function lineText(uri, line) {
  try {
    const lines = fs.readFileSync(fileURLToPath(uri), 'utf8').split('\n');
    return (lines[line] || '').trim();
  } catch {
    return '';
  }
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** 定義の場所 */
export async function findDefinition(name, root, hintFile) {
  const found = await locateSymbol(name, root, hintFile);
  if (!found) return { ok: false, reason: `"${name}" が見つかりませんでした。` };

  const result = await found.conn
    .request('textDocument/definition', {
      textDocument: { uri: found.uri },
      position: found.position
    })
    .catch(() => null);

  const places = asArray(result).map((d) => {
    const uri = d.uri || d.targetUri;
    const range = d.range || d.targetSelectionRange || d.targetRange;
    return { file: relFromUri(uri, root), line: (range?.start?.line ?? 0) + 1, text: lineText(uri, range?.start?.line ?? 0) };
  });

  // 定義に飛べなくても、見つけた場所そのものは返す（何も返さないよりよい）
  if (!places.length) {
    return {
      ok: true,
      places: [
        {
          file: relFromUri(found.uri, root),
          line: found.position.line + 1,
          text: lineText(found.uri, found.position.line)
        }
      ]
    };
  }
  return { ok: true, places };
}

/** 使われている場所 */
export async function findReferences(name, root, hintFile) {
  const found = await locateSymbol(name, root, hintFile);
  if (!found) return { ok: false, reason: `"${name}" が見つかりませんでした。` };

  const result = await found.conn
    .request('textDocument/references', {
      textDocument: { uri: found.uri },
      position: found.position,
      context: { includeDeclaration: false }
    })
    .catch(() => null);

  const places = asArray(result).map((r) => ({
    file: relFromUri(r.uri, root),
    line: (r.range?.start?.line ?? 0) + 1,
    text: lineText(r.uri, r.range?.start?.line ?? 0)
  }));
  return { ok: true, places };
}

/** 型や説明 */
export async function findHover(name, root, hintFile) {
  const found = await locateSymbol(name, root, hintFile);
  if (!found) return { ok: false, reason: `"${name}" が見つかりませんでした。` };

  const result = await found.conn
    .request('textDocument/hover', {
      textDocument: { uri: found.uri },
      position: found.position
    })
    .catch(() => null);

  const contents = result?.contents;
  let text = '';
  if (typeof contents === 'string') text = contents;
  else if (Array.isArray(contents)) text = contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
  else if (contents?.value) text = contents.value;

  return {
    ok: true,
    text: text.trim(),
    place: {
      file: relFromUri(found.uri, root),
      line: found.position.line + 1
    }
  };
}
