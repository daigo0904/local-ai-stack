// 入力に書かれた `@パス` を、そのファイルの中身に差し替える。
//
// 「src/agent.mjs のこの関数を直して」と頼むと、
// モデルはまず search_files → read_file と2手かけて探しに行く。
// 場所が分かっているなら、最初から渡したほうが速いし、間違えない。
//
//   ❯ @src/agent.mjs の runTurn を短くして
//   → 中身を添えたうえで送られる（道具の往復が2回減る）

import fs from 'node:fs';
import path from 'node:path';
import { isProbablyBinary, statSafe } from './paths.mjs';

/**
 * `@` に続くパスとして拾う範囲。
 *
 * 日本語のすぐ後ろで切りたいので、ASCII の記号・空白・全角文字で止める。
 * メールアドレスを拾わないよう、直前が英数字のものは対象にしない。
 */
const MENTION = /(^|[\s(（「『])@([A-Za-z0-9_./\-~]+)/g;

/** 1つのファイルから渡す量の上限。長すぎるファイルで文脈を埋めない。 */
const PER_FILE_LIMIT = 24000;

/** 1回の発言で渡す合計の上限。 */
const TOTAL_LIMIT = 60000;

/** 画像として渡す拡張子。 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** 画像1枚の上限。大きすぎるものは送っても処理に時間がかかるだけ。 */
const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;

export function isImagePath(p) {
  return IMAGE_EXT.has(path.extname(String(p)).toLowerCase());
}

/** 入力から `@パス` を拾う（重複は1つにまとめる）。 */
export function findMentions(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text).matchAll(MENTION)) {
    const raw = m[2].replace(/[.,;:]+$/, ''); // 文末の句読点は名前に含めない
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * 拾ったパスを実際に読む。
 *
 * 読めなかったものは黙って捨てない。
 * `@` を付けたのに何も起きないと、利用者は理由が分からない。
 */
export function resolveMentions(text, root, { vision = false } = {}) {
  const names = findMentions(text);
  if (!names.length) return { attachments: [], images: [], missing: [], text };

  const attachments = [];
  const images = [];
  const missing = [];
  let total = 0;

  for (const name of names) {
    const abs = path.resolve(root, name);

    // 作業フォルダの外は読まない。@../../.ssh/id_rsa のような指定を通さない。
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      missing.push({ name, reason: '作業フォルダの外です' });
      continue;
    }

    const st = statSafe(abs);
    if (!st) {
      missing.push({ name, reason: '見つかりません' });
      continue;
    }
    if (st.isDirectory()) {
      missing.push({ name, reason: 'フォルダです（ファイルを指定してください）' });
      continue;
    }
    // 画像は文字にせず、そのままモデルの目に渡す
    if (isImagePath(abs)) {
      if (!vision) {
        missing.push({
          name,
          reason: 'いまのモデルは画像を見られません（-m gemma4:26b などで試せます）'
        });
        continue;
      }
      if (st.size > IMAGE_LIMIT_BYTES) {
        missing.push({ name, reason: `画像が大きすぎます（${Math.round(st.size / 1024 / 1024)}MB）` });
        continue;
      }
      try {
        images.push({ name: rel, bytes: st.size, data: fs.readFileSync(abs).toString('base64') });
      } catch (err) {
        missing.push({ name, reason: `読めません（${err.code || err.message}）` });
      }
      continue;
    }

    if (total >= TOTAL_LIMIT) {
      missing.push({ name, reason: '一度に渡せる量を超えました' });
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      missing.push({ name, reason: `読めません（${err.code || err.message}）` });
      continue;
    }
    if (isProbablyBinary(buf)) {
      missing.push({ name, reason: '文字のファイルではありません' });
      continue;
    }

    let body = buf.toString('utf8');
    let truncated = false;
    const room = Math.min(PER_FILE_LIMIT, TOTAL_LIMIT - total);
    if (body.length > room) {
      body = body.slice(0, room);
      truncated = true;
    }
    total += body.length;
    attachments.push({ name: rel, chars: body.length, truncated, body });
  }

  return { attachments, images, missing, text };
}

/** モデルへ渡す形に組み立てる。 */
export function buildMentionBlock(attachments) {
  if (!attachments.length) return '';
  const parts = attachments.map(
    (a) =>
      `--- ${a.name} ---\n${a.body}${a.truncated ? '\n…[長いのでここまでを渡しています]' : ''}`
  );
  return (
    '\n\n# 添えられたファイル\n' +
    'The user referred to these with @. Their current contents are below — ' +
    'you do not need to read them again.\n\n' +
    parts.join('\n\n')
  );
}
