// ネットにつなぐ部分。検索（Tavily）とページ取得だけを持つ。
//
// このファイルは qwythos-code の中で唯一、外部へ出ていく場所。
// ここを読めば「何が、どこへ、どんな形で出ていくか」が全部分かるようにしてある。
//
// 出ていくもの: 検索の言葉（web_search）／取得したいURL（web_fetch）
// 出ていかないもの: ファイルの中身、会話の履歴、鍵、作業フォルダの場所

import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.mjs';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

// ── 鍵の読み取り ────────────────────────────────────────────

let cachedKey;

// `.env` の形（KEY=value）を素朴に読む。値の前後の引用符だけ外す。
function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const eq = l.indexOf('=');
    if (eq < 1) continue;
    const key = l.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = l.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// 検索の鍵。環境変数が最優先、次に ~/.qwythos-code/.env。
//
// 他のアプリの設定（~/.openclaw/.env など）は読みに行かない。
// 別のアプリの持ちものを黙って使うと、そちらを消したときにこちらが壊れる。
export function loadApiKey({ refresh = false } = {}) {
  if (!refresh && cachedKey !== undefined) return cachedKey;
  const fromEnv = process.env.TAVILY_API_KEY;
  if (fromEnv && fromEnv.trim()) {
    cachedKey = fromEnv.trim();
    return cachedKey;
  }
  const file = readEnvFile(path.join(HOME_DIR, '.env'));
  const fromFile = file.TAVILY_API_KEY;
  cachedKey = fromFile && fromFile.trim() ? fromFile.trim() : null;
  return cachedKey;
}

/** 鍵が無いときに画面へ出す案内。鍵そのものは絶対に出さない。 */
export const KEY_HELP =
  '検索の鍵（TAVILY_API_KEY）が見つかりません。次のどちらかで用意してください。\n' +
  '  1) export TAVILY_API_KEY=... を実行してから qwc を起動する\n' +
  `  2) ${path.join(HOME_DIR, '.env')} に TAVILY_API_KEY=... の1行を書く`;

// ── URL の検査 ──────────────────────────────────────────────

// 手元や社内のアドレスを表す名前・数字。
// エージェントは指示文に書かれた URL をそのまま取りに行くので、
// 「このページを読んで: http://127.0.0.1:11434/…」と書かれるだけで
// 手元のサービスを叩けてしまう。既定で塞ぐ。
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

function isPrivateAddress(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_HOSTS.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;

  // IPv4 の私有アドレス
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;      // リンクローカル（クラウドのメタデータ含む）
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  // IPv6 のループバック・ユニークローカル・リンクローカル
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe80:/.test(h)) return true;
  return false;
}

/**
 * 取りに行ってよい URL かを調べる。
 * 通らなかった理由は、そのままモデルへ返して直させる。
 */
export function checkUrl(raw, { allowLocal = false } = {}) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'url is required.' };

  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `Not a valid URL: ${text}. Include the scheme, like https://example.com.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Only http and https are allowed (got ${url.protocol}).` };
  }
  if (!allowLocal && isPrivateAddress(url.hostname)) {
    return {
      ok: false,
      reason:
        `Refusing to fetch a local or private address (${url.hostname}). ` +
        'web_fetch is for the public internet. Use read_file or run_command for things on this machine.'
    };
  }
  return { ok: true, url };
}

// ── HTML を読める文にする ───────────────────────────────────

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '・'
};

export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&([a-z]+);/gi, (whole, name) => {
      const hit = ENTITIES[name.toLowerCase()];
      return hit === undefined ? whole : hit;
    });
}

/**
 * HTML から本文らしいところだけを取り出す。
 *
 * 完全な変換は目指さない。モデルに読ませるのが目的なので、
 * 「script と style を消す」「段落の切れ目を改行にする」「タグを落とす」の3つで足りる。
 */
export function htmlToText(html) {
  let s = String(html);

  // 読ませても意味がなく、量だけ食うもの
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // 見出しは印を残す。あとで構造が分かるほうがモデルは扱いやすい
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${'#'.repeat(Number(level))} `);
  s = s.replace(/<\/h[1-6]>/gi, '\n\n');

  // 箇条書き
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/li>/gi, '');

  // 段落・改行になるもの
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|pre|header|footer|nav)>/gi, '\n\n');

  // 残りのタグを落とす
  s = s.replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s);

  // 空白の整理。行の中の連続空白は1つ、空行は最大2つまで
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.split('\n').map((l) => l.trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** <title> を取り出す */
export function extractTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// ── 実際の通信 ──────────────────────────────────────────────

/**
 * Tavily で検索する。
 *
 * 送るのは検索の言葉だけ。作業フォルダの場所やファイルの中身は送らない。
 */
export async function search(query, { maxResults = 5, signal, timeoutMs = 20000 } = {}) {
  const key = loadApiKey();
  if (!key) return { ok: false, reason: KEY_HELP };

  const body = {
    query: String(query),
    max_results: Math.min(10, Math.max(1, Number(maxResults) || 5)),
    search_depth: 'basic',
    include_answer: true
  };

  let res;
  try {
    res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return { ok: false, reason: '検索が時間内に終わりませんでした。' };
    }
    return { ok: false, reason: `検索に届きませんでした: ${err.message}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: `検索の鍵が受け付けられませんでした（${res.status}）。${KEY_HELP}` };
  }
  if (res.status === 429) {
    return { ok: false, reason: '検索の回数制限に達しました。しばらく待ってから試してください。' };
  }
  if (!res.ok) {
    return { ok: false, reason: `検索が失敗しました（HTTP ${res.status}）。` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: '検索の結果を読み取れませんでした。' };
  }

  const results = Array.isArray(data.results)
    ? data.results.map((r) => ({
        title: String(r.title || '').trim(),
        url: String(r.url || '').trim(),
        content: String(r.content || '').trim()
      }))
    : [];

  return { ok: true, answer: String(data.answer || '').trim(), results };
}

/**
 * ページを取ってきて、読める文にする。
 *
 * 大きすぎるページで文脈を食いつぶさないよう、読み込む量そのものに上限を置く
 * （全部受け取ってから切るのでは、回線と時間が無駄になる）。
 */
export async function fetchPage(rawUrl, { signal, timeoutMs = 20000, maxBytes = 2_000_000, allowLocal = false } = {}) {
  const checked = checkUrl(rawUrl, { allowLocal });
  if (!checked.ok) return { ok: false, reason: checked.reason };

  let res;
  try {
    res = await fetch(checked.url, {
      redirect: 'follow',
      headers: {
        // 名乗る。相手のサーバーのログに何が来たか分かるようにしておく。
        'user-agent': 'qwythos-code/0.1 (+local coding agent)',
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5'
      },
      signal: signal ?? AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return { ok: false, reason: `${checked.url.href} は時間内に応答しませんでした。` };
    }
    return { ok: false, reason: `${checked.url.href} に届きませんでした: ${err.message}` };
  }

  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status} ${res.statusText} — ${checked.url.href}` };
  }

  // 転送先が私有アドレスへ飛ばされていないか、最後にもう一度見る
  const finalUrl = res.url || checked.url.href;
  const recheck = checkUrl(finalUrl, { allowLocal });
  if (!recheck.ok) {
    return { ok: false, reason: `転送先が取得できない場所でした: ${recheck.reason}` };
  }

  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (/^(image|video|audio|font)\//.test(type) || type.includes('application/octet-stream')) {
    return { ok: false, reason: `${finalUrl} は文章ではありません（${type || '種類不明'}）。` };
  }

  let raw;
  try {
    raw = await readCapped(res, maxBytes);
  } catch (err) {
    return { ok: false, reason: `本文を受け取れませんでした: ${err.message}` };
  }

  const isHtml = type.includes('html') || /^\s*<(!doctype|html)/i.test(raw);
  const title = isHtml ? extractTitle(raw) : '';
  const text = isHtml ? htmlToText(raw) : raw.trim();

  return { ok: true, url: finalUrl, title, text, truncatedBytes: raw.truncated === true };
}

// 上限に達したところで受け取りを打ち切る
async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total >= maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* すでに閉じている */
      }
      break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
