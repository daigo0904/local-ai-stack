// フォルダごとの決まりごとと、書き換えたあとに走らせる処理。
//
// ■ フォルダごとの決まりごと（パススコープルール）
//     大きなリポジトリでは、場所によって作法が違う。
//     `src/` は TypeScript で書く、`migrations/` は手で編集しない、`docs/` は日本語で書く。
//     こういう話を全部いちばん上の QWYTHOS.md に書くと、
//     **触りもしないフォルダの作法まで毎回送ることになる**。32k の文脈ではそれが効いてくる。
//
//     そこで、触ったファイルの近くにある決まりごとだけを、触ったときに渡す。
//     読んだ・書いた瞬間に「このフォルダにはこう書いてある」と分かれば、
//     モデルは自分でそれに合わせられる。
//
//     同じものは1回しか渡さない。毎回付けると、同じ文が会話に何度も積もる。
//
// ■ 書き換えたあとに走らせる処理（編集フック）
//     整形や型検査は、人がやると忘れる。忘れたまま次の作業に進むと、
//     あとでまとめて直すことになる。書き換えた直後に走らせるのがいちばん安い。
//
//     失敗しても止めない。**出力をそのままモデルに返す**。
//     直せるのはモデルなので、こちらが握りつぶすと直す機会そのものが消える。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { statSafe, displayPath } from './paths.mjs';

/** フォルダごとの決まりごとを書くファイル名。上から順に探して、最初に見つかったものを使う */
export const RULE_FILES = ['QWYTHOS.md', 'AGENTS.md', 'CLAUDE.md', '.qwythos.md'];

/** 1つの決まりごとファイルの上限。これより大きいものは載せない（文脈を食い潰すため） */
const MAX_RULE_BYTES = 16000;

/**
 * そのファイルに効いている決まりごとを集める。
 *
 * 触ったファイルのあるフォルダから、作業フォルダまで上っていく。
 * 作業フォルダ直下のものは**含めない**。それは最初から指示文に入っているので、
 * ここで返すと同じ文を二重に送ることになる。
 */
export function rulesForPath(absPath, ctx) {
  const root = path.resolve(ctx.root);
  let dir = path.dirname(path.resolve(absPath));
  const found = [];

  // 上っていくが、作業フォルダより上には出ない
  for (let depth = 0; depth < 20; depth++) {
    if (!dir.startsWith(root) || dir === root) break;
    for (const name of RULE_FILES) {
      const file = path.join(dir, name);
      const st = statSafe(file);
      if (st && st.isFile() && st.size <= MAX_RULE_BYTES) {
        found.push(file);
        break; // 同じフォルダに何個あっても1つだけ
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 近いフォルダのものほど後ろに置く。指示は末尾にあるものほど効く。
  return found.reverse();
}

/**
 * まだ渡していない決まりごとを、渡せる形にして返す。
 *
 * 1回渡したものは覚えておいて、二度は渡さない。
 * 毎回付けると、同じ文が会話に何度も積もって文脈を食う。
 */
export function pendingRules(absPath, ctx) {
  if (!ctx.deliveredRules) ctx.deliveredRules = new Set();

  const parts = [];
  for (const file of rulesForPath(absPath, ctx)) {
    if (ctx.deliveredRules.has(file)) continue;
    ctx.deliveredRules.add(file);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    if (!text) continue;
    parts.push(
      `\n\n--- Rules for this folder (${displayPath(file, ctx)}) — they override the general instructions ---\n${text}`
    );
  }
  return parts.join('');
}

/**
 * 書き換えたあとに走らせる処理を読む。
 *
 * 置き場所は作業フォルダの `.qwythos/hooks.json`。
 * 整形の仕方はプロジェクトごとに違うので、利用者ごとの設定ではなくプロジェクトに置く。
 *
 * ```json
 * { "afterEdit": "npx prettier --write \"$QWC_FILE\"" }
 * ```
 */
export function loadHooks(root) {
  const file = path.join(root, '.qwythos', 'hooks.json');
  const st = statSafe(file);
  if (!st || !st.isFile()) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return { __error: `.qwythos/hooks.json が読めませんでした: ${err.message}` };
  }
}

/**
 * ファイルを書き換えたあとの処理を走らせる。
 *
 * 戻り値はモデルに見せる文字列（何も走らせなければ空）。
 * 失敗しても投げない。**出力をそのまま返す**——直せるのはモデルなので、
 * こちらが握りつぶすと直す機会そのものが消える。
 */
export function runAfterEdit(absPath, ctx) {
  const hooks = loadHooks(ctx.root);
  if (hooks.__error) return `\n\n[${hooks.__error}]`;

  const command = typeof hooks.afterEdit === 'string' ? hooks.afterEdit.trim() : '';
  if (!command) return '';

  const relative = path.relative(ctx.root, absPath) || path.basename(absPath);
  const result = spawnSync(command, {
    shell: true,
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: Math.min(ctx.config?.commandTimeoutMs ?? 120000, 120000),
    // コマンド側は $QWC_FILE で対象を受け取る。
    // 引数で渡す形にすると、シェルの引用符の扱いを利用者に押しつけることになる。
    env: { ...process.env, QWC_FILE: absPath, QWC_FILE_RELATIVE: relative }
  });

  if (result.error) {
    return `\n\n[afterEdit hook failed to start: ${result.error.message}]`;
  }

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status === 0) {
    // 成功したときは、出力があるときだけ載せる。
    // 「整形しました」の一行を毎回積むと、そのぶん文脈を食う。
    return output ? `\n\n[afterEdit hook ok] ${output.slice(0, 600)}` : '';
  }
  return (
    `\n\n[afterEdit hook failed (exit ${result.status})]\n${output.slice(0, 2000)}\n` +
    'Fix what it reported before moving on.'
  );
}
