// 自分で作るスラッシュコマンド。
//
// `.qwythos/commands/review.md` を置くと `/review` で呼べる。
// 中身がそのままモデルへの依頼になるので、
// 毎回同じ長い指示を打ち直さずに済む。
//
//   .qwythos/commands/review.md:
//     直近の変更を見て、抜けている検証と危ないところを指摘してください。
//     $ARGUMENTS
//
//   ❯ /review 認証まわりを重点的に
//   → 上の文の $ARGUMENTS が「認証まわりを重点的に」に置き換わって送られる

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 探す場所。作業フォルダが先（プロジェクト固有のものを優先する）。 */
function searchDirs(root) {
  return [
    path.join(root, '.qwythos', 'commands'),
    path.join(os.homedir(), '.qwythos-code', 'commands')
  ];
}

/** 1行目が見出しなら説明として使い、本文からは外す。 */
function splitHeading(text) {
  const lines = text.split('\n');
  const first = (lines[0] || '').trim();
  if (first.startsWith('#')) {
    return { description: first.replace(/^#+\s*/, ''), body: lines.slice(1).join('\n').trim() };
  }
  return { description: first.slice(0, 60), body: text.trim() };
}

/**
 * 使えるコマンドを集める。
 *
 * 同じ名前があれば作業フォルダ側が勝つ。
 * プロジェクトごとの事情を、共通のものより優先したいため。
 */
export function loadCommands(root) {
  const found = new Map();
  for (const dir of searchDirs(root).reverse()) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.replace(/\.md$/, '');
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      } catch {
        continue;
      }
      if (!text.trim()) continue;
      const { description, body } = splitHeading(text);
      found.set(name.toLowerCase(), { name: name.toLowerCase(), description, body, dir });
    }
  }
  return found;
}

/**
 * コマンドの中身を、実際に送る文にする。
 *
 * `$ARGUMENTS` があればそこへ引数を入れる。
 * 無ければ末尾に足す（書き忘れても引数が捨てられないように）。
 */
export function renderCommand(command, args) {
  const given = String(args || '').trim();
  if (command.body.includes('$ARGUMENTS')) {
    return command.body.replaceAll('$ARGUMENTS', given);
  }
  return given ? `${command.body}\n\n${given}` : command.body;
}

/**
 * 組み込みのコマンド名。
 *
 * 名前のぶつかりを見るのと、Tab の補完に出すのと、両方から使う。
 * 2か所に別々の一覧を置くと、コマンドを足したときに片方だけ古いままになる。
 */
export const BUILTIN_COMMANDS = [
  'help', 'clear', 'compact', 'model', 'think', 'yolo', 'accept', 'plan', 'chat',
  'todo', 'todos', 'commands', 'tools', 'stats', 'files', 'diff', 'undo',
  'refine', 'login', 'logins', 'logout', 'init', 'save', 'exit', 'quit'
];

/** `/init` などの組み込みと名前がぶつかっていないか。 */
export function isReserved(name) {
  return BUILTIN_COMMANDS.includes(String(name).toLowerCase());
}
