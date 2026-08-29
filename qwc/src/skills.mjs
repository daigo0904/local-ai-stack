// スキル。手順書を置いておいて、必要なときにモデル自身が読みにくる仕組み。
//
// ■ コマンド（`.qwythos/commands/*.md`）との違い
//     コマンドは**人が呼ぶ**もの。`/review` と打った人が、その手順を使うと決めている。
//     スキルは**モデルが呼ぶ**もの。人は「リリースして」としか言わない。
//     手順書があることに気づいて読みにいくのは、モデルのほうになる。
//
// ■ 全文を最初から渡さない
//     手順書は長い。5つ置いたら、それだけで文脈がかなり埋まる。
//     しかも、そのうち使うのはたいてい1つ。
//     そこで**名前と一行の説明だけ**を最初に見せて、
//     中身は `read_skill` で読みにきたときに渡す。
//
//     この「見出しだけ先に、中身は要るときに」は、
//     調べものの委譲（spawn_agent）や、フォルダごとの決まりごとと同じ考え方。
//     手元の小さいモデルでは、文脈をどれだけ空けておけるかがそのまま精度になる。
//
// ■ 置き場所
//     .qwythos/skills/<名前>/SKILL.md   … そのプロジェクト用
//     ~/.qwythos-code/skills/<名前>/SKILL.md … どのプロジェクトでも使える
//     同じ名前なら作業フォルダ側が勝つ（プロジェクトの事情を優先する）。
//
//     SKILL.md の頭に、こう書いておく：
//       ---
//       name: release
//       description: リリース手順。版を上げてタグを打つまで
//       ---

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 1つのスキルの上限。これより大きいものは載せない */
const MAX_SKILL_BYTES = 32000;

function searchDirs(root) {
  return [
    path.join(root, '.qwythos', 'skills'),
    path.join(os.homedir(), '.qwythos-code', 'skills')
  ];
}

/**
 * 頭の `---` で囲まれた部分を取り出す。
 *
 * ここだけを自前で読む。YAML をまるごと解釈する必要はない
 * （使うのは name と description の2つだけ）。
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (/^["'].*["']$/.test(value)) value = value.slice(1, -1);
    if (key) meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

/**
 * 使えるスキルを集める。
 *
 * 中身（body）も持っておくが、モデルに見せるのは name と description だけ。
 * 読み込み自体は起動時の1回で、そのあとファイルを触りにいかない。
 */
export function loadSkills(root) {
  const found = new Map();

  for (const dir of searchDirs(root)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) continue;

      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(text);
      const name = (meta.name || entry.name).trim();
      if (!name || found.has(name)) continue; // 先に見つけたほう（作業フォルダ側）が勝つ

      found.set(name, {
        name,
        description: (meta.description || '').trim(),
        body,
        file
      });
    }
  }

  return [...found.values()];
}

/**
 * 指示文に載せる一覧。
 *
 * 名前と一行の説明だけ。中身は読みにきたときに渡す。
 * ここに全文を載せると、使わないスキルのぶんまで毎ターン払うことになる。
 */
export function skillsBlock(skills) {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description || '(説明なし)'}`);
  return (
    '\n## Skills available in this project\n' +
    'These are written procedures for specific jobs. When one of them matches what you were asked,\n' +
    'call read_skill with its name FIRST and follow what it says. Do not guess the steps yourself.\n' +
    `${lines.join('\n')}\n`
  );
}
