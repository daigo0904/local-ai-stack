// Tab で補完する。
//
// ■ なぜ要るか
//   `@src/agent.mjs` のように、**正確に打たないと効かない**入力が増えた。
//   1文字違うと `@` は黙って素通しし、モデルは自分で search_files から探し直す。
//   打ち間違いの代償が「往復2回ぶん遅くなる」なので、そもそも打たせないほうがよい。
//
// ■ 補完するのは3つだけ
//   1. 行頭の `/`     … コマンド名（`.qwythos/commands` に自分で置いたぶんも）
//   2. `/model ` の後 … 入っているモデルの名前
//   3. `@`            … 作業フォルダのファイルとフォルダ
//   ふつうの日本語を打っている最中に候補が出ると邪魔にしかならないので、それ以外は何も出さない。
import fs from 'node:fs';
import path from 'node:path';

/** 何も打っていないときは出さないフォルダ。数が多いだけで、まず用が無い。 */
const NOISY = new Set(['node_modules', '.git', '.qwythos', 'dist', 'build', '.next', '.venv', '__pycache__']);

/** 一度に見せる候補の数。これ以上並べても読めない。 */
const MAX_HITS = 100;

/**
 * readline に渡す補完関数を作る。
 *
 * コマンドとモデルの一覧を**関数で**受け取るのは、あとから増えるため。
 * 起動時に配列で受け取ってしまうと、対話中に `.qwythos/commands` へ足したものが出てこない。
 */
export function makeCompleter({ root, commandNames = () => [], modelNames = () => [] }) {
  return (input) => {
    try {
      return complete(String(input ?? ''), { root, commandNames, modelNames });
    } catch {
      // 補完でつまずいて入力そのものを壊すのは論外。黙って「候補なし」に倒す
      return [[], String(input ?? '')];
    }
  };
}

/** 実際の振り分け。テストから直接呼べるように分けてある。 */
export function complete(input, { root, commandNames = () => [], modelNames = () => [] }) {
  // readline が渡してくるのは「行頭からカーソルまで」。末尾のかたまりを補う。
  const word = /(\S*)$/.exec(input)[1];

  // 1. /コマンド名（まだ空白を打っていない＝名前を打っている最中）
  if (/^\s*\/\S*$/.test(input)) {
    const names = [...new Set([...commandNames()])].sort();
    const hits = names.map((n) => `/${n}`).filter((n) => n.startsWith(word));
    return [hits.slice(0, MAX_HITS), word];
  }

  // 2. /model の引数
  const model = /^\s*\/model\s+(\S*)$/.exec(input);
  if (model) {
    const hits = modelNames().filter((n) => n.startsWith(model[1])).sort();
    return [hits.slice(0, MAX_HITS), model[1]];
  }

  // 3. @パス
  if (word.startsWith('@')) {
    const hits = completePath(word.slice(1), root).map((p) => `@${p}`);
    return [hits.slice(0, MAX_HITS), word];
  }

  return [[], word];
}

/**
 * 作業フォルダの中のパスを補う。
 *
 * フォルダは末尾に `/` を付けて返す。readline は候補が1つなら
 * そのまま差し込むので、`@src/` まで入ってすぐ次を打ち始められる。
 * 空白は足さない（足すと、フォルダを選んだ時点で行が終わってしまう）。
 */
export function completePath(prefix, root) {
  const cut = prefix.lastIndexOf('/');
  const dirPart = cut >= 0 ? prefix.slice(0, cut + 1) : '';
  const base = cut >= 0 ? prefix.slice(cut + 1) : prefix;

  const dirAbs = path.resolve(root, dirPart || '.');
  // 作業フォルダの外は出さない。出したところで `@` は受け取らない
  const rel = path.relative(root, dirAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (!e.name.startsWith(base)) continue;
    // 打たれていないものは出さない。隠しファイルも、重いフォルダも同じ扱い
    if (!base && (NOISY.has(e.name) || e.name.startsWith('.'))) continue;
    if (base && !base.startsWith('.') && e.name.startsWith('.')) continue;
    (e.isDirectory() ? dirs : files).push(dirPart + e.name + (e.isDirectory() ? '/' : ''));
  }
  dirs.sort();
  files.sort();
  return [...dirs, ...files];
}
