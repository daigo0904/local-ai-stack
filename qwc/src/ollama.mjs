// Ollama の /api/chat と話す部分。逐次（ストリーミング）で受け取る。
import http from 'node:http';
import https from 'node:https';

const jsonHeaders = { 'Content-Type': 'application/json' };

export class OllamaError extends Error {}

// 待ち時間の既定値。
//
// ■ なぜ fetch を使わないのか
//     Node の fetch は、応答のヘッダが返るまで **300秒で必ず諦める**（undici の headersTimeout）。
//     この値を設定で伸ばす方法は公開されていない。
//     実測: 12,668 トークンの依頼を投げたら、301秒ちょうどで `fetch failed`
//     （`UND_ERR_HEADERS_TIMEOUT`）になった。Ollama 側は無事で、こちらが先に諦めていた。
//     暖まっていれば前処理は毎秒500トークンほど出るが、モデルの読み込みや
//     文脈枠の取り直しが挟まると、最初の1文字までが分単位になる。そこで踏む。
//     やり取りが長い2か所だけ node:http で投げ直し、待ち方をこちらで決める。
const FIRST_TOKEN_MS = 15 * 60 * 1000; // 最初の1文字が出るまで（長い文脈の下ごしらえを待つ）
const STALL_MS = 10 * 60 * 1000;       // 出はじめたあとで途切れたとき（config.mjs に理由）

/**
 * JSON を POST して、応答を Node の Readable のまま返す。
 *
 * 止まったときは自分で見切る。切れ目は2段階で見る。
 * 出はじめる前は長く待つ（下ごしらえに時間がかかるだけかもしれない）。
 * 出はじめたあとは短く切る（途中で止まったのなら、待っても戻らない）。
 */
export function postStream({ url, payload, signal, firstTokenMs = FIRST_TOKEN_MS, stallMs = STALL_MS }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new OllamaError(`つなぎ先の指定が読めません: ${url}`));
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { ...jsonHeaders, 'Content-Length': body.length },
        signal
      },
      (res) => {
        // ここで res に 'data' を聞きに行ってはいけない。
        // listener を足した時点で流れ出し、受け取り手より先に最初の断片を持っていってしまう。
        // 出はじめたあとの見切りは、読む側（withStallTimeout）で計る。
        resolve(res);
      }
    );

    // つながりが切れたことに、時間切れを待たずに気づけるようにする。
    //
    // **無音そのものは正常**で、Ollama は道具の呼び出しを書き終えるまで
    // 何も送ってこない。だから「黙っていること」を死んだ証拠にはできない。
    // 見たいのは「相手がもういないこと」なので、そこは TCP に見張らせる。
    // Ollama が落ちれば、無音の見切り（stallMs）を待たずにここでエラーになる。
    req.on('socket', (socket) => {
      socket.setKeepAlive(true, 30000);
    });

    req.setTimeout(firstTokenMs, () => {
      req.destroy(new OllamaError(waitedTooLong(firstTokenMs)));
    });
    req.on('error', (err) => {
      if (err.name === 'AbortError') return reject(err);
      if (err instanceof OllamaError) return reject(err);
      reject(new OllamaError(`Ollama につながりません (${url}): ${err.message}`));
    });
    req.end(body);
  });
}

function waitedTooLong(ms) {
  return (
    `Ollama が ${Math.round(ms / 60000)} 分だまったままなので、待つのをやめました。` +
    'いま送っている文脈が長すぎるのかもしれません（/clear で会話を空にするか、小さいモデルに替えてみてください）。'
  );
}

/**
 * 断片と断片のあいだが空きすぎたら見切る。
 *
 * 読む側で計るので、途中の断片を横取りしない。
 * 最初の1つは計らない。応答が返ってきた時点で下ごしらえは終わっているし、
 * そこに至るまでの長い待ちは postStream 側（`firstTokenMs`）が見ている。
 */
async function* withStallTimeout(res, stallMs = STALL_MS) {
  const iter = res[Symbol.asyncIterator]();
  let first = true;
  for (;;) {
    let timer;
    const gaveUp = new Promise((_, reject) => {
      timer = setTimeout(() => {
        res.destroy();
        reject(new OllamaError(stalled(stallMs)));
      }, stallMs);
    });
    let next;
    try {
      // 最初の1つは、応答が返ってきた時点で下ごしらえが済んでいるので待たなくてよい
      next = first ? await iter.next() : await Promise.race([iter.next(), gaveUp]);
    } finally {
      clearTimeout(timer);
    }
    first = false;
    if (next.done) return;
    yield next.value;
  }
}

function stalled(ms) {
  return (
    `Ollama からの返事が ${Math.round(ms / 60000)} 分とぎれたので、待つのをやめました。` +
    'Ollama は道具の呼び出しを書き終えるまで送ってこないので、長い引数を組み立てている' +
    'あいだは無音になります。心当たりがあるなら stallMs を伸ばしてください。'
  );
}

/** 応答の中身を最後まで文字列で受け取る */
async function readAll(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function checkServer(cfg) {
  try {
    const res = await fetch(`${cfg.host}/api/version`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new OllamaError(`HTTP ${res.status}`);
    const data = await res.json();
    return { ok: true, version: data.version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function listModels(cfg) {
  const res = await fetch(`${cfg.host}/api/tags`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new OllamaError(`モデル一覧が取れませんでした (HTTP ${res.status})`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

// ── モデルが GPU に丸ごと載ったかを見る ──────────────────────
//
// 載りきらないと、はみ出した分は CPU 側で動く。**これが一番痛い遅さ**で、
// 実測では GPU に収まっているときの数分の一まで落ちる。しかも画面には何も出ないので、
// 「今日はなぜか遅い」としか分からない。他のアプリが GPU を掴んでいるときに起きる。
//
// 空きを先に測る手立ては Ollama には無い（他アプリの取り分は見えない）。
// 実際に載せてから `/api/ps` の size_vram と size を比べるのが唯一の確実な方法。
// 読み込みは最初のやり取りでどのみち起きるので、それを起動時に前倒しするだけ。

// モデルを読み込ませる（生成はしない）。prompt を空にすると Ollama は読み込みだけ行う。
//
// **num_ctx を必ず一緒に渡すこと。** 渡さないと Ollama は既定の広さで載せてしまい、
// 直後の本番のやり取りが違う広さを求めた時点で、17GB を積み直す羽目になる。
// 実測: 65,536 で使う設定のまま num_ctx を省いたら、毎回 6.2 秒の積み直しが挟まった
// （渡すようにしたら 0.2 秒）。載っているのに「読み込み」が出るときは、ここを疑う。
export async function preloadModel(cfg, name = cfg.model, timeoutMs = 10 * 60 * 1000) {
  const res = await fetch(`${cfg.host}/api/generate`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ model: name, keep_alive: cfg.keepAlive, options: { num_ctx: cfg.numCtx } }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new OllamaError(`モデルを読み込めませんでした (HTTP ${res.status})`);
  await res.json();
}

// いま載っているモデルの内訳。GPU に何割載ったかを返す。
export async function loadedModels(cfg) {
  const res = await fetch(`${cfg.host}/api/ps`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new OllamaError(`読み込み状況が取れませんでした (HTTP ${res.status})`);
  const data = await res.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    size: m.size || 0,
    vram: m.size_vram || 0,
    // size が 0 のときに 0 除算しない。分からないものは「載っている」扱いにして騒がない
    onGpu: m.size ? (m.size_vram || 0) / m.size : 1
  }));
}

// GPU に載りきらなかったモデルには、軽いものに落とすよう促す。
//
// 判定を 1.0 にはしない。数値には端数があり、ぴったり 100% にならないことがある。
// 一方で 5% ほどのはみ出しなら実害は出ないので、そこは通す。
export const GPU_FIT_THRESHOLD = 0.95;

export async function checkGpuFit(cfg, name = cfg.model) {
  try {
    await preloadModel(cfg, name);
    const loaded = await loadedModels(cfg);
    // Ollama は指定と少し違う名前で返すことがある（:latest の付け外し）
    const bare = (s) => String(s).replace(/:latest$/, '');
    const mine = loaded.find((m) => bare(m.name) === bare(name));
    if (!mine) return { ok: true, unknown: true };
    return {
      ok: mine.onGpu >= GPU_FIT_THRESHOLD,
      onGpu: mine.onGpu,
      size: mine.size,
      vram: mine.vram
    };
  } catch (err) {
    // 測れなかったときは黙って通す。確かめられないことを理由に、使えるものを取り上げない
    return { ok: true, unknown: true, error: err.message };
  }
}

// モデルが何をできるか（tools / thinking など）を聞く。
// 思考モードを持たないモデルに think を送るとエラーになるので、事前に合わせるために使う。
export async function showModel(cfg, name = cfg.model) {
  try {
    const res = await fetch(`${cfg.host}/api/show`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { ok: false, capabilities: [] };
    const data = await res.json();
    return {
      ok: true,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      contextLength: data.model_info?.[`${data.model_info?.['general.architecture']}.context_length`] ?? null,
      parameterSize: data.details?.parameter_size ?? null
    };
  } catch {
    return { ok: false, capabilities: [] };
  }
}

// 取得した能力に合わせて設定を寄せる。戻り値は利用者に伝えるべき注意点。
/**
 * 入っているモデルの中から、この用途に向くものを1つ選ぶ。
 *
 * 指定されたモデルが無いときに、いきなり終了させないためのもの。
 * 「どれを使うか」を利用者に考えさせる前に、こちらで妥当なものを出す。
 *
 * 埋め込み専用のモデルは会話ができないので外す。
 * 名前の並びは、実測で自律的に走り切れた順。
 */
export function pickBestModel(models) {
  const usable = models.filter((m) => !/embed/i.test(m));
  if (!usable.length) return null;

  const preferred = [
    /^gemma4/i,         // MoEで実効3.8B。26Bだが9Bより速く、書くコードも正しかった
    /^qwythos/i,        // 9B。軽い（7.4GB）。gemma4 が載らない環境向け
    /^qwen3:14b/i,      // 遅いが確実
    /^qwen2\.5-coder/i, // 癖はあるが対策済み
    /^qwen3:/i,
    /^qwen2\.5:/i
  ];
  for (const rule of preferred) {
    const hit = usable.find((m) => rule.test(m));
    if (hit) return hit;
  }
  return usable[0];
}

export async function adaptToModel(cfg) {
  const info = await showModel(cfg);
  const notes = [];
  if (!info.ok) return { info, notes };

  const canThink = info.capabilities.includes('thinking');
  const canTools = info.capabilities.includes('tools');
  // 目を持っているモデルだけが画像を受け取れる。
  // 持っていないモデルに送ると、無視されるか、そのまま失敗する。
  const canVision = info.capabilities.includes('vision');
  cfg.vision = canVision;

  // 利用者の希望（thinkPreference）は残したまま、実際に送る値だけモデルに合わせる
  if (cfg.thinkPreference === undefined) cfg.thinkPreference = Boolean(cfg.think);
  cfg.think = cfg.thinkPreference && canThink;
  if (cfg.thinkPreference && !canThink) {
    notes.push({ level: 'info', text: `${cfg.model} は思考モードを持たないので、思考なしで動かします。` });
  }
  if (!canTools) {
    notes.push({
      level: 'error',
      text:
        `${cfg.model} はツール呼び出しに対応していません。` +
        'このアプリはツールでファイルを読み書きするため、このモデルでは動きません。'
    });
  }
  return { info, notes, canTools, canThink, canVision };
}

function buildOptions(cfg) {
  return {
    num_ctx: cfg.numCtx,
    temperature: cfg.temperature,
    top_p: cfg.topP,
    top_k: cfg.topK,
    repeat_penalty: cfg.repeatPenalty
  };
}

// 本文に書かれてしまった道具の呼び出しを拾う。
//
// qwen2.5-coder のように「道具は使えます」と申告しておきながら、
// 決められたタグ（<tool_call>）を付けずに JSON をそのまま本文へ書くモデルがある。
// その場合 Ollama は解釈できず、道具は永遠に呼ばれない。
// モデル側は直せないので、こちらで受け止める。
/**
 * 本文に `道具の名前(引数)` と書かれているものを拾う。
 *
 * 見境なく拾うと、説明のつもりで書いた一文まで実行してしまう。そこで3つとも満たすものだけを取る。
 *   1. 行の先頭から始まっている（文の途中で触れただけのものは取らない）
 *   2. 名前がいま渡している道具のもの
 *   3. 引数の名前が、その道具が実際に持っている引数と一致する
 * 3つめが効く。`spawn_agent(task=…)` は通り、`これは spawn_agent(便利です)` は通らない。
 */
function findCallLikeText(text, tools) {
  const specs = new Map();
  for (const t of tools || []) {
    const fn = t?.function;
    if (fn?.name) specs.set(fn.name, Object.keys(fn.parameters?.properties || {}));
  }
  if (!specs.size || !text) return [];

  // ``` で囲まれた中は見ない。書き方の例として見せているだけで、実行してほしいわけではない。
  // （JSON の受け皿は逆に ```json の中を見に行く。あちらは道具の呼び出しがそこに書かれるため）
  const scan = maskFences(text);

  const found = [];
  const lineStart = /(^|\n)[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  let m;
  while ((m = lineStart.exec(scan))) {
    const name = m[2];
    const keys = specs.get(name);
    if (!keys) continue;

    const open = m.index + m[0].length - 1;
    const close = matchingParen(text, open);
    if (close < 0) continue;

    const inner = text.slice(open + 1, close).trim();
    const args = parseArgText(inner, keys);
    if (!args) continue;

    found.push({ name, args, raw: text.slice(m.index + m[1].length, close + 1) });
    lineStart.lastIndex = close;
  }
  return found;
}

/** ``` の中を同じ長さの空白に置き換える（位置がずれないようにするため） */
function maskFences(text) {
  return text.replace(/```[\s\S]*?(```|$)/g, (block) => block.replace(/[^\n]/g, ' '));
}

/** 引用符の中の丸括弧は数えずに、対になる `)` を探す */
function matchingParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * 括弧の中を引数に直す。`{...}` の JSON か、`名前="値"` の並びだけを受け付ける。
 * その道具が持っていない引数名が1つでも混ざっていたら、まるごと諦める（取り違えるより出さないほうがよい）。
 */
function parseArgText(inner, keys) {
  if (!inner) return null;

  if (inner.startsWith('{')) {
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.keys(parsed).every((k) => keys.includes(k)) ? parsed : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  const args = {};
  const pair = /([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]*)/g;
  let seen = 0;
  let m;
  while ((m = pair.exec(inner))) {
    const key = m[1];
    if (!keys.includes(key)) return null;
    let value = m[2].trim();
    if (/^["']/.test(value)) {
      try {
        value = JSON.parse(value[0] === "'" ? `"${value.slice(1, -1).replace(/"/g, '\\"')}"` : value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    }
    args[key] = value;
    seen++;
  }
  return seen ? args : null;
}

export function salvageToolCalls(text, tools) {
  const known = new Set((tools || []).map((t) => t?.function?.name).filter(Boolean));
  if (!known.size || !text) return { calls: [], cleaned: text };

  const candidates = [];
  const push = (raw, json) => candidates.push({ raw, json });

  // <tool_call>{...}</tool_call>
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) push(m[0], m[1]);
  // ```json {...} ```
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) push(m[0], m[1]);
  // 本文まるごとが JSON
  const whole = text.trim();
  if (whole.startsWith('{') && whole.endsWith('}')) push(whole, whole);
  if (whole.startsWith('[') && whole.endsWith(']')) push(whole, whole);

  const calls = [];
  let cleaned = text;

  // 関数を書くような形 ── spawn_agent(task="…") ── で本文に書くモデルがある。
  // JSON ではないので上の受け皿では拾えない。実測（qwythos 9B）では、
  // こちらから道具の名前を出して頼むと、その名前をそのまま文章に書き写して手を止める。
  for (const found of findCallLikeText(text, tools)) {
    calls.push({ id: `salvaged_${calls.length}`, name: found.name, args: found.args });
    cleaned = cleaned.replace(found.raw, '');
  }

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.json.trim());
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let used = false;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const name = item.name || item.tool || item.function?.name;
      const args = item.arguments ?? item.parameters ?? item.function?.arguments ?? {};
      if (typeof name === 'string' && known.has(name) && args && typeof args === 'object') {
        calls.push({ id: `salvaged_${calls.length}`, name, args });
        used = true;
      }
    }
    if (used) cleaned = cleaned.replace(candidate.raw, '');
  }

  return { calls, cleaned: cleaned.trim() };
}

// 逐次で届く断片を、扱いやすい形のイベントに直して流す。
// yield されるもの:
//   { type: 'thinking', text }   … 考えている途中の文
//   { type: 'content',  text }   … 本文
//   { type: 'done', message, stats } … 1回分の応答が完成
export async function* chatStream({ cfg, messages, tools, signal }) {
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    think: Boolean(cfg.think),
    keep_alive: cfg.keepAlive,
    options: buildOptions(cfg)
  };
  if (tools && tools.length) body.tools = tools;

  const res = await postStream({
    url: `${cfg.host}/api/chat`,
    payload: body,
    signal,
    firstTokenMs: cfg.firstTokenMs,
    stallMs: cfg.stallMs
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const detail = await readAll(res).catch(() => '');
    throw new OllamaError(`Ollama がエラーを返しました (HTTP ${res.statusCode}): ${detail.slice(0, 400)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  const toolCalls = [];
  let stats = null;

  const pushToolCall = (call) => {
    const fn = call.function || {};
    const index = typeof fn.index === 'number' ? fn.index : toolCalls.length;
    let slot = toolCalls.find((t) => t.index === index);
    if (!slot) {
      slot = { index, id: call.id || `call_${index}`, name: '', argsText: '', args: null };
      toolCalls.push(slot);
    }
    if (call.id) slot.id = call.id;
    if (fn.name) slot.name = fn.name;
    if (typeof fn.arguments === 'string') {
      // 断片で届く場合に備えてつなげる
      slot.argsText += fn.arguments;
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      slot.args = fn.arguments;
    }
  };

  for await (const chunk of withStallTimeout(res, cfg.stallMs)) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!raw) continue;

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        continue; // 壊れた行は捨てる
      }

      if (data.error) throw new OllamaError(String(data.error));

      const msg = data.message || {};
      if (msg.thinking) {
        thinking += msg.thinking;
        yield { type: 'thinking', text: msg.thinking };
      }
      if (msg.content) {
        content += msg.content;
        yield { type: 'content', text: msg.content };
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) pushToolCall(call);
      }

      if (data.done) {
        stats = {
          promptTokens: data.prompt_eval_count || 0,
          outputTokens: data.eval_count || 0,
          totalMs: Math.round((data.total_duration || 0) / 1e6),
          evalMs: Math.round((data.eval_duration || 0) / 1e6),
          // 前処理（送った会話を読む時間）。ローカルでは待ち時間の大半がここなので、
          // 生成と分けて持たないと「なぜ遅いのか」が最後まで分からない。
          promptMs: Math.round((data.prompt_eval_duration || 0) / 1e6),
          loadMs: Math.round((data.load_duration || 0) / 1e6),
          doneReason: data.done_reason || 'stop'
        };
      }
    }
  }

  let finalCalls = toolCalls
    .sort((a, b) => a.index - b.index)
    .map((slot) => {
      let args = slot.args;
      if (!args && slot.argsText) {
        try {
          args = JSON.parse(slot.argsText);
        } catch {
          args = { __parseError: slot.argsText };
        }
      }
      return { id: slot.id, name: slot.name, args: args || {} };
    })
    .filter((call) => call.name);

  // 正規の道具呼び出しが1つも無いのに、本文が道具呼び出しの形をしている場合は拾う
  let salvaged = false;
  if (!finalCalls.length && content.trim()) {
    const rescue = salvageToolCalls(content, tools);
    if (rescue.calls.length) {
      finalCalls = rescue.calls;
      content = rescue.cleaned;
      salvaged = true;
    }
  }

  const message = { role: 'assistant', content };
  if (thinking) message.thinking = thinking;
  if (finalCalls.length) {
    message.tool_calls = finalCalls.map((call) => ({
      id: call.id,
      function: { name: call.name, arguments: call.args }
    }));
  }

  yield { type: 'done', message, toolCalls: finalCalls, stats: stats || {}, salvaged };
}

// ツールなしで一発だけ答えてもらう（要約などの裏方仕事に使う）
//
// ここも node:http で投げる。まとめ直しは会話まるごとを送るので、いちばん長くなる。
// 文脈が溢れたから要約するのに、その要約が300秒で切られては元も子もない。
export async function chatOnce({ cfg, messages, signal, temperature = 0.2 }) {
  const res = await postStream({
    url: `${cfg.host}/api/chat`,
    signal,
    firstTokenMs: cfg.firstTokenMs,
    stallMs: cfg.stallMs,
    payload: {
      model: cfg.model,
      messages,
      stream: false,
      think: false,
      keep_alive: cfg.keepAlive,
      options: { ...buildOptions(cfg), temperature }
    }
  });
  const text = await readAll(res);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new OllamaError(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new OllamaError('Ollama の返事が読めませんでした');
  }
  return (data.message && data.message.content) || '';
}
