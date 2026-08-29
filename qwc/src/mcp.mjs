// MCP（Model Context Protocol）。外の道具をつないで使えるようにする。
//
// ■ 何のためにあるのか
//     qwc に同梱してある道具は、ファイルとネットとブラウザだけ。
//     データベースを引く、社内のAPIを叩く、といったことはできない。
//     MCP は、そういう道具を**別のプログラムとして**用意して、つなぐための決まりごと。
//     つなぎ方さえ守れば、誰が書いた道具でも使える。
//
// ■ 話し方は LSP とほぼ同じ
//     標準入出力で JSON-RPC 2.0 をやりとりする。
//     `Content-Length:` のヘッダが要らないぶん、LSP より簡単（行ごとの JSON）。
//     だから `src/lsp.mjs` と同じく、ライブラリなしで素で書ける。
//
// ■ ここでいちばん気をつけたこと：道具を増やしすぎない
//     MCP のサーバーは、1つで20個も30個も道具を持っていることがある。
//     それを全部モデルに見せると、**手元の9Bは選べなくなる**。
//     qwc が同梱の道具を13個に絞っているのと、真っ向からぶつかる。
//
//     そこで、**設定に書いた道具だけ**を渡す。
//     `"tools": ["query"]` と書けば、そのサーバーが30個持っていても渡すのは1つ。
//     省略したときは、そのサーバーの道具を**先頭から数個だけ**渡す（既定8個）。
//     全部渡す方法は用意していない。用意すると、いちばん効く歯止めが外れる。
//
// ■ 設定（作業フォルダの `.qwythos/mcp.json`）
//     {
//       "servers": {
//         "sqlite": {
//           "command": "uvx",
//           "args": ["mcp-server-sqlite", "--db-path", "./app.db"],
//           "tools": ["read_query", "list_tables"]
//         }
//       }
//     }

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { statSafe } from './paths.mjs';

/** 道具の名前が何個まで渡るか（サーバーごと・設定で絞っていないとき） */
const DEFAULT_TOOL_LIMIT = 8;

/** 立ち上げと最初のやりとりを何秒待つか */
const START_TIMEOUT_MS = 20000;

/** 道具1回の実行を何秒待つか */
const CALL_TIMEOUT_MS = 120000;

/** つないだサーバー。名前 → { proc, send, tools } */
const connected = new Map();

/**
 * 設定を読む。
 *
 * 置き場所は作業フォルダの `.qwythos/mcp.json`。
 * どのデータベースにつなぐかはプロジェクトごとに違うので、利用者ごとの設定には置かない。
 */
export function loadMcpConfig(root) {
  const file = path.join(root, '.qwythos', 'mcp.json');
  const st = statSafe(file);
  if (!st || !st.isFile()) return { servers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const servers = parsed && typeof parsed.servers === 'object' ? parsed.servers : {};
    return { servers };
  } catch (err) {
    return { servers: {}, error: `.qwythos/mcp.json が読めませんでした: ${err.message}` };
  }
}

/** 1つのサーバーとの、行ごとの JSON-RPC のやりとり */
function connect(name, spec, root) {
  const proc = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(spec.env || {}) }
  });

  const waiting = new Map();
  let nextId = 1;
  let spawnError = null;

  // 立ち上げそのものに失敗したとき（コマンドが無い、権限が無い）は
  // ここに来る。拾わないと Node が例外を投げて **qwc ごと落ちる**。
  // 外の道具の設定を1文字書き間違えただけで本体が落ちるのは、割に合わない。
  proc.on('error', (err) => {
    spawnError = err;
    for (const [id, pending] of waiting) {
      waiting.delete(id);
      pending({ id, error: { message: err.message } });
    }
  });

  const rl = readline.createInterface({ input: proc.stdout, terminal: false });
  rl.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // 道具側が出した普通のログは捨てる
    }
    const pending = message.id != null ? waiting.get(message.id) : null;
    if (!pending) return;
    waiting.delete(message.id);
    pending(message);
  });

  // サーバーの標準エラーは捨てない。つながらないときの唯一の手がかりになる。
  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2000);
  });

  const closed = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));

  const send = (method, params, timeoutMs) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${name} が ${Math.round(timeoutMs / 1000)} 秒で返事をしませんでした。`));
      }, timeoutMs);

      waiting.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) {
          reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          resolve(message.result);
        }
      });

      if (spawnError) {
        clearTimeout(timer);
        waiting.delete(id);
        reject(spawnError);
        return;
      }

      try {
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        waiting.delete(id);
        reject(err);
      }
    });

  const notify = (method, params) => {
    if (spawnError) return;
    try {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      /* 相手が落ちていれば、次の send がその旨を返す */
    }
  };

  return { proc, send, notify, closed, stderr: () => stderrTail };
}

/**
 * 設定に書かれたサーバーをすべて立ち上げて、使える道具を集める。
 *
 * 1つ失敗しても他は続ける。理由は notes に入れて利用者に見せる
 * （黙って道具が減っていると、なぜ動かないのか分からなくなる）。
 */
export async function startMcp(root) {
  const config = loadMcpConfig(root);
  const notes = [];
  const tools = [];

  if (config.error) return { tools, notes: [config.error] };

  for (const [name, spec] of Object.entries(config.servers)) {
    if (!spec || typeof spec.command !== 'string' || !spec.command) {
      notes.push(`${name}: command が書かれていないので、つなぎませんでした。`);
      continue;
    }

    let session;
    try {
      session = connect(name, spec, root);
      await session.send(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'qwythos-code', version: '0.1.0' }
        },
        START_TIMEOUT_MS
      );
      session.notify('notifications/initialized', {});
    } catch (err) {
      notes.push(`${name}: つなげませんでした（${err.message}）。`);
      session?.proc.kill();
      continue;
    }

    let list;
    try {
      list = await session.send('tools/list', {}, START_TIMEOUT_MS);
    } catch (err) {
      notes.push(`${name}: 道具の一覧を取れませんでした（${err.message}）。`);
      session.proc.kill();
      continue;
    }

    const available = Array.isArray(list?.tools) ? list.tools : [];
    const wanted = Array.isArray(spec.tools) ? spec.tools : null;

    // 設定で絞っていればその通りに。していなければ先頭から数個だけ。
    // 全部渡す道は用意しない。用意すると、いちばん効く歯止めが外れる。
    let chosen = wanted
      ? available.filter((t) => wanted.includes(t.name))
      : available.slice(0, DEFAULT_TOOL_LIMIT);

    if (wanted) {
      const missing = wanted.filter((w) => !available.some((t) => t.name === w));
      if (missing.length) {
        notes.push(`${name}: ${missing.join(', ')} という道具はありません（あるのは ${available.map((t) => t.name).join(', ') || 'なし'}）。`);
      }
    } else if (available.length > DEFAULT_TOOL_LIMIT) {
      notes.push(
        `${name}: 道具が${available.length}個あるので、先頭の${DEFAULT_TOOL_LIMIT}個だけ渡します。` +
          '使うものを mcp.json の "tools" に書くと、そのぶん迷いが減ります。'
      );
    }

    connected.set(name, session);

    for (const tool of chosen) {
      tools.push(makeTool(name, tool));
    }
  }

  return { tools, notes };
}

/**
 * MCP の道具を、qwc の道具の形に包む。
 *
 * 名前は `mcp__<サーバー>__<道具>` にする。
 * 同梱の道具と見分けがつかないと、使えなくなったときに
 * どちらの話なのか利用者に説明できない。
 */
function makeTool(server, spec) {
  return {
    name: `mcp__${server}__${spec.name}`,
    // 外の道具が何をするかは、こちらには分からない。
    // 分からないものを黙って走らせない（ファイルを消す道具かもしれない）。
    approval: 'always',
    description: `[${server}] ${spec.description || spec.name}`,
    parameters:
      spec.inputSchema && typeof spec.inputSchema === 'object'
        ? spec.inputSchema
        : { type: 'object', properties: {} },
    approvalTitle: () => `外の道具を実行します: ${server} の ${spec.name}`,
    preview: (args) => JSON.stringify(args ?? {}, null, 2).slice(0, 800),
    async run(args) {
      const session = connected.get(server);
      if (!session) {
        return { isError: true, output: `${server} につながっていません。`, display: '未接続' };
      }
      try {
        const result = await session.send(
          'tools/call',
          { name: spec.name, arguments: args ?? {} },
          CALL_TIMEOUT_MS
        );
        return {
          output: renderResult(result),
          display: result?.isError ? 'エラーが返りました' : 'done',
          isError: Boolean(result?.isError)
        };
      } catch (err) {
        return { isError: true, output: `${server} の ${spec.name} が失敗しました: ${err.message}`, display: '失敗' };
      }
    }
  };
}

/** MCP の返り値を文字にする。中身の形は道具ごとに違うので、扱える形だけ拾う。 */
function renderResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts = [];
  for (const item of content) {
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item?.type === 'resource' && item.resource?.text) parts.push(item.resource.text);
    else if (item?.type) parts.push(`[${item.type} は文字にできないので省きました]`);
  }
  if (parts.length) return parts.join('\n');
  return typeof result === 'string' ? result : JSON.stringify(result ?? {}, null, 2);
}

/** つないだサーバーを全部止める。終了時に呼ぶ。 */
export function stopMcp() {
  for (const [, session] of connected) {
    try {
      session.proc.kill();
    } catch {
      /* もう死んでいるなら何もしない */
    }
  }
  connected.clear();
}
