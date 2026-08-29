// エージェントが使える道具（ツール）一式。
// 小さいモデルでも迷わないように、数を絞ってある（手元6個＋ネット2個）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { resolveSafe, displayPath, isIgnored, isProbablyBinary, statSafe } from './paths.mjs';
import { renderDiff, truncateForDisplay, renderTodos, c } from './ui.mjs';
import { search as webSearchApi, fetchPage, loadApiKey, KEY_HELP } from './web.mjs';
import { browse, openForLogin, finishLogin, INSTALL_HELP as BROWSER_HELP } from './browser.mjs';
import { isSafeCommand } from './permissions.mjs';
import { findDefinition, findReferences, findHover, anyServerAvailable } from './lsp.mjs';
import { runSubagent } from './subagent.mjs';
import { pendingRules, runAfterEdit } from './rules.mjs';
import { loadSkills } from './skills.mjs';
import { recordEdit } from './edits.mjs';

// 長すぎる出力は真ん中を省いて前後を残す
export function truncateOutput(text, max) {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.6);
  const tailLen = max - headLen;
  const omitted = text.length - max;
  // 省略したことは、モデルに分かる書き方で伝える。
  // 実測: 「…[N 文字を省略しました]…」だけだと 9B は気づかず、
  // 45KB のファイルの前3分の1だけを見て「該当は2つです」と答えた（本当は6つあった）。
  // 何が起きたかだけでなく、**次に何をすればよいか**まで書く。
  return (
    `${text.slice(0, headLen)}\n\n` +
    `…[${omitted} characters omitted from the middle. THIS IS NOT THE WHOLE OUTPUT — ` +
    'do not conclude anything about the omitted part. If it matters, read it with offset/limit ' +
    'or narrow your search.]…\n\n' +
    `${text.slice(-tailLen)}`
  );
}

// 見つからなかったパスに近いものを探して教える。
// 小さいモデルはパスを取り違えやすいので、正解の候補を返して自力で直させる。
function suggestPaths(target, ctx, limit = 6) {
  const wanted = path.basename(String(target || '')).toLowerCase();
  if (!wanted) return '';
  const hits = [];
  let visited = 0;

  const walk = (dir, depth) => {
    if (depth > 4 || hits.length >= limit || visited > 4000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= limit) return;
      if (entry.name.startsWith('.') || isIgnored(entry.name)) continue;
      visited++;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase() === wanted) {
        hits.push(path.relative(ctx.root, full));
      }
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(ctx.root, 1);

  if (hits.length) {
    return `\nDid you mean one of these? ${hits.join(', ')}`;
  }
  let top = [];
  try {
    top = fs
      .readdirSync(ctx.root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && !isIgnored(e.name))
      .slice(0, 20)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    top = [];
  }
  return top.length
    ? `\nPaths are relative to the workspace root. The root contains: ${top.join(', ')}`
    : '';
}

function numberLines(text, startLine = 1) {
  return text
    .split('\n')
    .map((l, i) => `${String(startLine + i).padStart(5)}\t${l}`)
    .join('\n');
}

// ripgrep があれば検索に使う（無ければ自前の走査に切り替える）
function hasRipgrep() {
  if (hasRipgrep.cached === undefined) {
    try {
      hasRipgrep.cached = spawnSync('rg', ['--version'], { encoding: 'utf8' }).status === 0;
    } catch {
      hasRipgrep.cached = false;
    }
  }
  return hasRipgrep.cached;
}

// ── 1. ファイルを読む ────────────────────────────────────────
const readFile = {
  name: 'read_file',
  approval: 'never',
  description:
    'Read a text file from the workspace. Returns the content with line numbers. ' +
    'Always read a file before editing it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      offset: { type: 'integer', description: 'Optional 1-based line number to start from.' },
      limit: { type: 'integer', description: 'Optional maximum number of lines to return.' }
    },
    required: ['path']
  },
  async run(args, ctx) {
    const abs = resolveSafe(args.path, ctx);
    const st = statSafe(abs);
    if (!st) {
      return {
        isError: true,
        output: `File not found: ${args.path}${suggestPaths(args.path, ctx)}`,
        display: 'ファイルが見つかりません'
      };
    }
    if (st.isDirectory()) {
      return { isError: true, output: `${args.path} is a directory. Use list_dir instead.`, display: 'フォルダです' };
    }
    if (st.size > ctx.config.maxFileBytes) {
      return {
        isError: true,
        output: `File is too large (${st.size} bytes). Read it in parts with offset/limit.`,
        display: `大きすぎます (${Math.round(st.size / 1024)}KB)`
      };
    }
    const buf = fs.readFileSync(abs);
    if (isProbablyBinary(buf)) {
      return { isError: true, output: `${args.path} looks like a binary file and cannot be read as text.`, display: 'バイナリのため読めません' };
    }

    const text = buf.toString('utf8');
    const allLines = text.split('\n');
    const start = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || 2000);
    const slice = allLines.slice(start - 1, start - 1 + limit);

    if (slice.length === 0) {
      return { output: `(no lines at offset ${start}; file has ${allLines.length} lines)`, display: '該当行なし' };
    }

    const shown = numberLines(slice.join('\n'), start);
    const more = allLines.length > start - 1 + slice.length
      ? `\n\n[showing lines ${start}-${start + slice.length - 1} of ${allLines.length}]`
      : '';
    ctx.readFiles.add(abs);
    // このフォルダに決まりごとがあれば、読んだこの瞬間に渡す。
    // 触りもしないフォルダの作法まで最初から全部送ると、そのぶん文脈を食う。
    return {
      output: truncateOutput(shown + more, ctx.config.maxToolChars) + pendingRules(abs, ctx),
      display: `${slice.length} 行を読み込み`
    };
  }
};

/**
 * 控えのために、書き換える前の中身を読む。
 *
 * 読めなかったときに null を返すのは「無かった」という意味ではない。
 * 呼ぶ側が `existed` を別に渡しているので、ここは中身だけを返す。
 */
function readForUndo(abs) {
  try {
    const buf = fs.readFileSync(abs);
    if (isProbablyBinary(buf)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// ── 2. ファイルを丸ごと書く ──────────────────────────────────
const writeFile = {
  name: 'write_file',
  // 実行後に、書いた中身を画面に出す（agent.mjs が preview を使う）
  showsDiff: true,
  // 既存を丸ごと置き換えうるので、必ず人に見せてから
  approval: 'always',
  description:
    'Create a new file, or overwrite an existing one with the given content. ' +
    'For small changes to an existing file prefer edit_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      content: { type: 'string', description: 'The full content to write.' }
    },
    required: ['path', 'content']
  },
  approvalTitle(args, ctx) {
    const abs = resolveSafe(args.path, ctx);
    return fs.existsSync(abs) ? `ファイルを上書きします: ${args.path}` : `ファイルを新規作成します: ${args.path}`;
  },
  preview(args, ctx) {
    const abs = resolveSafe(args.path, ctx);
    const content = String(args.content ?? '');
    if (fs.existsSync(abs)) {
      return renderDiff(fs.readFileSync(abs, 'utf8'), content);
    }
    return truncateForDisplay(
      content.split('\n').map((l, i) => c.green(`  ${String(i + 1).padStart(4)} +${l}`)).join('\n'),
      20
    );
  },
  async run(args, ctx) {
    const abs = resolveSafe(args.path, ctx);
    const content = String(args.content ?? '');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    // 上書きする前の姿を控える（`/undo` で戻し、`/diff` で通しの差分を出すため）。
    // 読めない形（画像などを丸ごと置き換える場合）は控えず、戻せないと伝える側に倒す。
    const before = existed ? readForUndo(abs) : null;
    fs.writeFileSync(abs, content, 'utf8');
    recordEdit(ctx, { path: abs, before, after: content, existed });
    ctx.changedFiles.add(abs);
    ctx.readFiles.add(abs);
    ctx.mutations = (ctx.mutations || 0) + 1;
    const lines = content.split('\n').length;
    return {
      output:
        `${existed ? 'Overwrote' : 'Created'} ${displayPath(abs, ctx)} (${lines} lines).` +
        pendingRules(abs, ctx) +
        runAfterEdit(abs, ctx),
      display: `${existed ? '上書き' : '新規作成'} (${lines} 行)`
    };
  }
};

// ── 3. ファイルの一部を置き換える ────────────────────────────
const editFile = {
  name: 'edit_file',
  // 実行後に、置き換えた箇所を画面に出す
  showsDiff: true,
  // 差分を見てから決められるようにする
  approval: 'always',
  description:
    'Replace an exact snippet of text inside an existing file. ' +
    'old_string must match the file content exactly, including indentation, and must be unique ' +
    'unless replace_all is true. Read the file first, and copy the text WITHOUT the line numbers ' +
    'that read_file adds. To append to the end of a file, use the last existing lines as old_string ' +
    'and repeat them followed by the new code in new_string.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to find. Include enough surrounding lines to be unique.' },
      new_string: { type: 'string', description: 'Text to replace it with. Use an empty string to delete.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  approvalTitle(args) {
    return `ファイルを編集します: ${args.path}`;
  },
  // 確認を出す前に、そもそも成立する編集かを見る（失敗ならユーザーを煩わせない）
  validate(args, ctx) {
    const abs = resolveSafe(args.path, ctx);
    if (!fs.existsSync(abs)) {
      return `File not found: ${args.path}${suggestPaths(args.path, ctx)}`;
    }
    const before = fs.readFileSync(abs, 'utf8');
    const result = applyEdit(before, args);
    if (!result.error) {
      // 通ったら数えを消す。次に詰まったときは、また最初から数える
      ctx.editFailures?.delete(abs);
      return null;
    }
    return result.error + escalateAfterRepeatedFailure(abs, before, ctx);
  },
  preview(args, ctx) {
    const abs = resolveSafe(args.path, ctx);
    if (!fs.existsSync(abs)) return c.red('  (ファイルが存在しません)');
    const before = fs.readFileSync(abs, 'utf8');
    const after = applyEdit(before, args);
    if (after.error) return c.red(`  ${after.error}`);
    return renderDiff(before, after.text);
  },
  async run(args, ctx) {
    const abs = resolveSafe(args.path, ctx);
    if (!fs.existsSync(abs)) {
      return {
        isError: true,
        output: `File not found: ${args.path}${suggestPaths(args.path, ctx)}`,
        display: 'ファイルが見つかりません'
      };
    }
    const before = fs.readFileSync(abs, 'utf8');
    const result = applyEdit(before, args);
    if (result.error) {
      return { isError: true, output: result.error, display: '置き換えできませんでした' };
    }
    fs.writeFileSync(abs, result.text, 'utf8');
    recordEdit(ctx, { path: abs, before, after: result.text, existed: true });
    ctx.changedFiles.add(abs);
    ctx.mutations = (ctx.mutations || 0) + 1;
    return {
      output:
        `Edited ${displayPath(abs, ctx)} (${result.count} replacement${result.count > 1 ? 's' : ''}).` +
        pendingRules(abs, ctx) +
        runAfterEdit(abs, ctx),
      display: `${result.count} か所を置き換え${result.fuzzy ? '（空白のズレを補正）' : ''}`
    };
  }
};

/** 同じファイルで、この回数だけ続けて失敗したら、やり方を変えさせる */
const EDIT_FAILURE_LIMIT = 2;

/** 差し替えの案内に添えられるファイルの上限。これを超えるものは丸ごと書き直させない */
const REWRITE_MAX_LINES = 400;

/**
 * 同じファイルで edit_file が続けて失敗したときに、道を変えさせる。
 *
 * ■ なぜ要るか
 *   一致しない → 少し違う old_string で作り直す → また一致しない、を延々と繰り返す。
 *   実機の記録では 83.9 秒の思考を挟んで同じ失敗を続けていた。
 *   引数が毎回わずかに違うので、同じ呼び出しを止める仕掛け（duplicateLimit）では捕まらない。
 *
 * ■ 何をするか
 *   2回続けて外したら「その道はもう通らない」と伝え、**現物の全文を渡して write_file に切り替えさせる**。
 *   長すぎるファイルでは丸ごと書き直させない（別の壊し方になるため）。そのときは範囲を狭めさせる。
 */
function escalateAfterRepeatedFailure(abs, before, ctx) {
  if (!ctx.editFailures) ctx.editFailures = new Map();
  const count = (ctx.editFailures.get(abs) || 0) + 1;
  ctx.editFailures.set(abs, count);
  if (count < EDIT_FAILURE_LIMIT) return '';

  const lines = before.split('\n');
  const rel = displayPath(abs, ctx);

  if (lines.length > REWRITE_MAX_LINES) {
    return (
      `\n\nYou have now failed to edit ${rel} ${count} times in a row. Stop guessing at old_string.\n` +
      'Read a small part of the file with read_file using offset and limit, so you see one screen of ' +
      'exact text, then copy old_string from that. Do not send an old_string you have not just read.'
    );
  }

  return (
    `\n\nYou have now failed to edit ${rel} ${count} times in a row. **Stop using edit_file on this file.**\n` +
    'Call write_file with the complete new content instead. Below is the file exactly as it is on disk ' +
    'right now, with no line numbers. Copy it, apply your change to your copy, and send the whole thing:\n\n' +
    before
  );
}

// read_file は行番号つきで返すので、それをそのまま貼ってきた場合に剥がす
function stripLineNumbers(text) {
  const lines = text.split('\n');
  const numbered = lines.filter((l) => l !== '');
  if (numbered.length && numbered.every((l) => /^\s*\d+\t/.test(l))) {
    return lines.map((l) => l.replace(/^\s*\d+\t/, '')).join('\n');
  }
  return text;
}

function applyEdit(before, args) {
  const rawOld = String(args.old_string ?? '');
  const rawNew = String(args.new_string ?? '');

  // そのままで一致するならいじらない。一致しないときだけ行番号を剥がして試す。
  let oldStr = rawOld;
  let newStr = rawNew;
  if (rawOld !== '' && !before.includes(rawOld)) {
    const stripped = stripLineNumbers(rawOld);
    if (stripped !== rawOld) {
      oldStr = stripped;
      newStr = stripLineNumbers(rawNew);
    }
  }

  if (oldStr === '') {
    return { error: 'old_string must not be empty. Use write_file to create a new file.' };
  }
  if (oldStr === newStr) {
    return { error: 'old_string and new_string are identical; nothing to change.' };
  }

  const parts = before.split(oldStr);
  const count = parts.length - 1;

  if (count === 1 || (count > 1 && args.replace_all)) {
    return { text: parts.join(newStr), count };
  }
  if (count > 1) {
    return {
      error:
        `old_string appears ${count} times. Add more surrounding lines so it is unique, ` +
        'or set replace_all to true.'
    };
  }

  // 完全一致しなかったとき、行末の空白やインデントのズレだけなら救う
  const matches = fuzzyLineMatch(before, oldStr);
  if (matches.length === 1 || (matches.length > 1 && args.replace_all)) {
    const fileLines = before.split('\n');
    const targets = matches.length === 1 ? matches : [...matches].reverse();
    for (const m of targets) {
      const replacement = newStr
        .split('\n')
        .map((l) => (m.indent && l.trim() !== '' ? m.indent + l : l));
      fileLines.splice(m.start, m.end - m.start, ...replacement);
    }
    return { text: fileLines.join('\n'), count: targets.length, fuzzy: true };
  }
  if (matches.length > 1) {
    return {
      error:
        `A whitespace-insensitive match for old_string appears ${matches.length} times. ` +
        'Add more surrounding lines so it is unique, or set replace_all to true.'
    };
  }

  // それでも駄目なら、**狙った場所の現物**を返して直させる。
  //
  // ここで先頭80行を返してはいけない。長いファイルでは狙った場所が入っておらず、
  // モデルは手がかりの無いまま推測を繰り返す。実際に Sidebar.tsx で無限に往復した。
  // いちばん近い場所を探して、その周りだけを出す。
  const near = nearestRegion(before, oldStr);
  const lines = before.split('\n');
  if (near) {
    const from = Math.max(0, near.start - 6);
    const to = Math.min(lines.length, near.end + 6);
    const shown = numberLines(lines.slice(from, to).join('\n'), from + 1);
    return {
      error:
        'old_string was not found in the file. It must match the file text exactly.\n' +
        `The closest place is around line ${near.start + 1} ` +
        `(${near.matched} of your ${near.total} lines appear there).\n` +
        'Here is what the file actually contains there. Copy from this, without the line numbers:\n\n' +
        shown
    };
  }

  // 近いところが1つも無い＝そもそも別のファイルを見ている可能性が高い
  const head = numberLines(lines.slice(0, 60).join('\n'));
  const more = lines.length > 60 ? `\n…[${lines.length - 60} more lines]` : '';
  return {
    error:
      'old_string was not found in the file, and nothing in it resembles what you sent. ' +
      'You may be editing the wrong file, or working from an old copy of it. ' +
      'Read the file again before trying another edit.\n\n' +
      `${head}${more}`
  };
}

/**
 * old_string に**いちばん近い場所**を探す。
 *
 * 一致は諦めたあとに呼ぶ。狙いはどこを直そうとしていたのかを言い当てることだけで、
 * 置き換えはしない（それは fuzzyLineMatch の仕事で、あちらは確実なときしか動かない）。
 *
 * 中身が半分も重ならない場所は返さない。見当違いの場所を「ここです」と言うと、
 * モデルはそこを信じて別の間違いを重ねる。
 */
function nearestRegion(before, oldStr) {
  const fileLines = before.split('\n');
  const oldLines = oldStr.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (oldLines.length === 0) return null;

  const n = Math.min(oldLines.length, fileLines.length);
  let best = null;

  for (let i = 0; i + n <= fileLines.length; i++) {
    const window = fileLines.slice(i, i + n).map((l) => l.trim());
    let matched = 0;
    for (const line of oldLines) {
      const at = window.indexOf(line);
      if (at >= 0) matched++;
    }
    if (!best || matched > best.matched) {
      best = { start: i, end: i + n, matched, total: oldLines.length };
    }
  }

  if (!best || best.matched * 2 < best.total) return null;
  return best;
}

// 行末の空白の違い、または全行そろって同じだけずれたインデントを許して探す
function fuzzyLineMatch(before, oldStr) {
  const fileLines = before.split('\n');
  const oldLines = oldStr.split('\n');
  while (oldLines.length > 1 && oldLines[oldLines.length - 1].trim() === '') oldLines.pop();
  const n = oldLines.length;
  if (n === 0 || n > fileLines.length) return [];

  const matches = [];
  for (let i = 0; i + n <= fileLines.length; i++) {
    const window = fileLines.slice(i, i + n);

    if (window.every((l, k) => l.trimEnd() === oldLines[k].trimEnd())) {
      matches.push({ start: i, end: i + n, indent: '' });
      continue;
    }
    if (!window.every((l, k) => l.trim() === oldLines[k].trim())) continue;

    // 空でない行すべてで「足りない字下げ」が同じなら、その分だけ足して合わせる
    const prefixes = new Set();
    let ok = true;
    window.forEach((l, k) => {
      if (l.trim() === '') return;
      const fileIndent = l.match(/^\s*/)[0];
      const oldIndent = oldLines[k].match(/^\s*/)[0];
      if (!fileIndent.endsWith(oldIndent)) {
        ok = false;
        return;
      }
      prefixes.add(fileIndent.slice(0, fileIndent.length - oldIndent.length));
    });
    if (ok && prefixes.size === 1) {
      matches.push({ start: i, end: i + n, indent: [...prefixes][0] });
    }
  }
  return matches;
}

// ── 4. フォルダの中身を見る ──────────────────────────────────
const listDir = {
  name: 'list_dir',
  approval: 'never',
  description: 'List files and folders. Use this to explore the project structure.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path. Defaults to the workspace root.' },
      depth: { type: 'integer', description: 'How many levels deep to list. Default 2, max 4.' }
    }
  },
  async run(args, ctx) {
    const abs = resolveSafe(args.path || '.', ctx);
    const st = statSafe(abs);
    if (!st) {
      return {
        isError: true,
        output: `Directory not found: ${args.path || '.'}${suggestPaths(args.path || '.', ctx)}`,
        display: '見つかりません'
      };
    }
    if (!st.isDirectory()) return { isError: true, output: `${args.path} is a file, not a directory.`, display: 'ファイルです' };

    const maxDepth = Math.min(4, Math.max(1, Number(args.depth) || 2));
    const lines = [];
    let count = 0;
    const LIMIT = 400;

    const walk = (dir, depth, prefix) => {
      if (depth > maxDepth || count >= LIMIT) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        if (count >= LIMIT) break;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        if (isIgnored(entry.name)) {
          lines.push(`${prefix}${entry.name}/ (skipped)`);
          continue;
        }
        count++;
        if (entry.isDirectory()) {
          lines.push(`${prefix}${entry.name}/`);
          walk(path.join(dir, entry.name), depth + 1, `${prefix}  `);
        } else {
          const size = statSafe(path.join(dir, entry.name))?.size ?? 0;
          lines.push(`${prefix}${entry.name} (${size}B)`);
        }
      }
    };

    walk(abs, 1, '');
    const header = `${displayPath(abs, ctx)}/`;
    const body = lines.length ? lines.join('\n') : '(empty)';
    const note = count >= LIMIT ? `\n[stopped after ${LIMIT} entries]` : '';
    return {
      output: truncateOutput(`${header}\n${body}${note}`, ctx.config.maxToolChars),
      display: `${count} 件`
    };
  }
};

// ── 5. 文字列を探す ──────────────────────────────────────────
const searchFiles = {
  name: 'search_files',
  approval: 'never',
  description:
    'Search the workspace for a regular expression and return matching lines with file names ' +
    'and line numbers. Use this to locate code before reading whole files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Directory or file to search in. Defaults to the workspace root.' },
      glob: { type: 'string', description: 'Optional file filter such as *.js or *.py.' }
    },
    required: ['pattern']
  },
  async run(args, ctx) {
    const pattern = String(args.pattern || '');
    if (!pattern) return { isError: true, output: 'pattern is required.', display: 'パターンが空です' };
    const abs = resolveSafe(args.path || '.', ctx);
    const MAX_MATCHES = 120;

    if (hasRipgrep()) {
      const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '20', '-e', pattern];
      if (args.glob) rgArgs.push('--glob', String(args.glob));
      rgArgs.push(abs);
      const result = await runProcess('rg', rgArgs, { cwd: ctx.root, timeoutMs: 30000 });
      if (result.code === 1 && !result.output.trim()) {
        return { output: 'No matches found.', display: '一致なし' };
      }
      const rel = result.output
        .split('\n')
        .filter(Boolean)
        .slice(0, MAX_MATCHES)
        .map((l) => (l.startsWith(ctx.root) ? l.slice(ctx.root.length + 1) : l))
        .join('\n');
      const total = result.output.split('\n').filter(Boolean).length;
      const note = total > MAX_MATCHES ? `\n[${total - MAX_MATCHES} more matches not shown]` : '';
      return {
        output: truncateOutput(rel + note, ctx.config.maxToolChars),
        display: `${Math.min(total, MAX_MATCHES)} 件ヒット`
      };
    }

    // ripgrep が無いときの自前検索
    let re;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return { isError: true, output: `Invalid regular expression: ${err.message}`, display: '正規表現が不正' };
    }
    const globRe = args.glob ? globToRegExp(String(args.glob)) : null;
    const matches = [];
    const walk = (dir) => {
      if (matches.length >= MAX_MATCHES) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= MAX_MATCHES) return;
        if (entry.name.startsWith('.') || isIgnored(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          if (globRe && !globRe.test(entry.name)) continue;
          const st = statSafe(full);
          if (!st || st.size > ctx.config.maxFileBytes) continue;
          let buf;
          try {
            buf = fs.readFileSync(full);
          } catch {
            continue;
          }
          if (isProbablyBinary(buf)) continue;
          buf.toString('utf8').split('\n').forEach((text, i) => {
            if (matches.length >= MAX_MATCHES) return;
            if (re.test(text)) {
              matches.push(`${path.relative(ctx.root, full)}:${i + 1}:${text.slice(0, 300)}`);
            }
          });
        }
      }
    };
    const st = statSafe(abs);
    if (st && st.isFile()) {
      fs.readFileSync(abs, 'utf8').split('\n').forEach((text, i) => {
        if (matches.length < MAX_MATCHES && re.test(text)) {
          matches.push(`${path.relative(ctx.root, abs)}:${i + 1}:${text.slice(0, 300)}`);
        }
      });
    } else {
      walk(abs);
    }

    if (!matches.length) return { output: 'No matches found.', display: '一致なし' };
    return {
      output: truncateOutput(matches.join('\n'), ctx.config.maxToolChars),
      display: `${matches.length} 件ヒット`
    };
  }
};

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// ── 6. コマンドを実行する ────────────────────────────────────
const runCommand = {
  name: 'run_command',
  // 読み取り専用のものだけ素通し。判断は needsApproval にある。
  approval: 'conditional',
  description:
    'Run a shell command in the workspace and return its combined output and exit code. ' +
    'Use it to run tests, build, install packages, or inspect the system. ' +
    'Do not use it for interactive programs that wait for input.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      cwd: { type: 'string', description: 'Optional directory to run in, relative to the workspace root.' },
      timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds. Default 120000.' }
    },
    required: ['command']
  },
  approvalTitle(args) {
    return 'コマンドを実行します';
  },
  preview(args) {
    return c.cyan(`  $ ${String(args.command || '').slice(0, 500)}`);
  },
  needsApproval(args, ctx, perms) {
    return !perms.isSafeCommand(args.command || '');
  },
  async run(args, ctx) {
    const command = String(args.command || '').trim();
    if (!command) return { isError: true, output: 'command is required.', display: 'コマンドが空です' };

    // 計画モードでは、状態を変えうるコマンドは実行しない。
    // 「調べてから提案する」ための時間なので、調べる以外はさせない。
    // 雑談モードも同じ扱いにする。話の途中で環境が変わってしまわないように。
    if ((ctx.config.planMode || ctx.config.chatMode) && !isSafeCommand(command, ctx.config)) {
      const chatting = ctx.config.chatMode;
      return {
        isError: true,
        output: chatting
          ? 'You are in chat mode: only read-only commands are allowed right now. ' +
            'Tell the user what you would run, and that /chat switches back to working mode.'
          : 'You are in plan mode: only read-only commands are allowed right now. ' +
            'Finish investigating, then describe what you would run as part of your plan.',
        display: chatting ? '雑談中なので実行しません' : '計画中なので実行しません'
      };
    }

    const cwd = args.cwd ? resolveSafe(args.cwd, ctx) : ctx.root;
    const timeoutMs = Math.min(600000, Number(args.timeout_ms) || ctx.config.commandTimeoutMs);

    const result = await runProcess(command, null, { cwd, timeoutMs, shell: true, signal: ctx.signal });
    // 実際にコマンドが走ったこと自体を数える。
    // 「実行しました」という報告が本当かどうかは、これでしか確かめられない。
    ctx.mutations = (ctx.mutations || 0) + 1;
    const body = result.output.trim() || '(no output)';
    const status = result.timedOut
      ? `Command timed out after ${timeoutMs} ms and was killed.`
      : `Exit code: ${result.code}`;
    return {
      isError: result.code !== 0,
      output: truncateOutput(`${status}\n\n${body}`, ctx.config.maxToolChars),
      display: result.timedOut ? '時間切れで停止' : `終了コード ${result.code}`
    };
  }
};

// 止めたコマンドの出力を、どれだけ待ってから諦めるか（ミリ秒）。
//
// 本人が終わっても、出力の口を握った孫が残っていると `close` は上がってこない。
// 普通のコマンドなら終了から数ミリ秒で閉じるので、この長さで足りる。
export const OUTPUT_DRAIN_MS = 2000;

function runProcess(command, argv, { cwd, timeoutMs, shell = false, signal } = {}) {
  return new Promise((resolve) => {
    // 標準入力は /dev/null につなぐ。
    //
    // 既定の 'pipe' のままだと、こちらが閉じない書き込み口を子が握ったままになる。
    // すると入力を待つコマンド（cat / git commit / ssh / パスワードを聞くもの）が
    // 永久に読み待ちになり、時間切れまで画面が止まる。実測で `cat` が 120 秒まるごと固まった。
    // /dev/null なら最初の読みで終端が返るので、待たずに終わる。
    //
    // detached を立てるのは、始末するときに孫まで届かせるため。
    // shell: true の子は `/bin/sh` で、本当のコマンドはその下にいる。
    // sh だけ殺しても本体は生き残るので、グループごと止められるようにしておく。
    const options = { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true };
    const child = argv ? spawn(command, argv, options) : spawn(command, { ...options, shell: true });
    let output = '';
    let timedOut = false;
    let settled = false;
    let exitCode = null;

    const limit = 400000;
    const append = (chunk) => {
      if (output.length < limit) output += chunk.toString();
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    // 子とその子孫を、まとめて止める。
    // detached を立ててあるので子はグループ長になっており、
    // マイナスの PID を渡すと、そのグループ全員に届く。
    const killTree = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // グループがもう無いときはここに来る。単体で試して終わり
        try {
          child.kill('SIGKILL');
        } catch {
          /* すでに終了している */
        }
      }
    };

    // 止めたのに `close` が来ないことがある。
    // 出力の口を握った孫が残っていると、そこが閉じるまで `close` は上がってこない
    // （`npm run dev &` のように裏へ回るコマンドで実際に起きる）。
    // 待ち続けると対話ごと固まるので、少しだけ待って自分で切り上げる。
    let drainTimer = null;
    const drainSoon = () => {
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => finish(exitCode), OUTPUT_DRAIN_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      drainSoon();
    }, timeoutMs || 120000);

    const onAbort = () => {
      killTree();
      drainSoon();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, output, timedOut });
    };

    child.on('error', (err) => {
      output += `\n${err.message}`;
      finish(127);
    });
    // exit は本人が終わった時点、close は出力の口が全部閉じた時点。
    // 孫が残っていると close だけ来ないので、exit を見たら締め切りを用意しておく。
    child.on('exit', (code, sig) => {
      exitCode = code ?? (sig ? 137 : 0);
      drainSoon();
    });
    child.on('close', (code) => finish(code ?? exitCode ?? 0));
  });
}

// ── 7. ネットで調べる ────────────────────────────────────────
//
// ここから下の2つだけが、このPCの外へ出る道具。
// 出ていくのは「検索の言葉」と「URL」だけで、ファイルの中身も会話も送らない。
const webSearch = {
  name: 'web_search',
  approval: 'always',
  description:
    'Search the public internet and return short summaries with source URLs. ' +
    'Use it for things this machine cannot know: current library versions, release notes, ' +
    'error messages you do not recognise, or API documentation. ' +
    'Do not use it for anything about the local project — read those files instead.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for. Be specific; include version numbers or exact error text.' },
      max_results: { type: 'integer', description: 'How many results to return (1-10). Default 5.' }
    },
    required: ['query']
  },
  approvalTitle() {
    return 'ネットで検索します';
  },
  preview(args) {
    return `${c.cyan(`  ${String(args.query || '').slice(0, 300)}`)}\n${c.gray('  この言葉が検索サービス（Tavily）へ送られます')}`;
  },
  async run(args, ctx) {
    if (ctx.config.net === false) {
      return { isError: true, output: 'Web access is disabled (--no-net).', display: 'ネット接続は切られています' };
    }
    const query = String(args.query || '').trim();
    if (!query) return { isError: true, output: 'query is required.', display: '検索語が空です' };

    const res = await webSearchApi(query, {
      maxResults: args.max_results,
      signal: ctx.signal,
      timeoutMs: ctx.config.netTimeoutMs
    });
    if (!res.ok) return { isError: true, output: res.reason, display: '検索できませんでした' };
    if (!res.results.length) {
      return { output: `No results for: ${query}`, display: '結果なし' };
    }

    const parts = [];
    if (res.answer) parts.push(`Summary: ${res.answer}\n`);
    res.results.forEach((r, i) => {
      parts.push(`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`);
    });
    parts.push('\nThese are external sources. Verify anything important against the actual project files.');

    return {
      output: truncateOutput(parts.join('\n'), ctx.config.maxToolChars),
      display: `${res.results.length} 件`
    };
  }
};

// ── 8. ページを読む ──────────────────────────────────────────
const webFetch = {
  name: 'web_fetch',
  approval: 'always',
  description:
    'Fetch one public web page and return it as readable text. ' +
    'Use it when you have a specific URL — from web_search, from the user, or from a file. ' +
    'It cannot reach localhost or private addresses.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full URL, including https://' }
    },
    required: ['url']
  },
  approvalTitle() {
    return 'ネット上のページを読みます';
  },
  preview(args) {
    return c.cyan(`  ${String(args.url || '').slice(0, 300)}`);
  },
  async run(args, ctx) {
    if (ctx.config.net === false) {
      return { isError: true, output: 'Web access is disabled (--no-net).', display: 'ネット接続は切られています' };
    }
    // fetchPage が返すのは Response ではなく、読み終えた中身。
    // { ok, reason } か { ok, url, title, text } のどちらか。
    const res = await fetchPage(args.url, {
      signal: ctx.signal,
      timeoutMs: ctx.config.netTimeoutMs,
      maxBytes: ctx.config.maxFetchBytes
    });
    if (!res.ok) return { isError: true, output: res.reason, display: '読めませんでした' };

    const head = res.title ? `# ${res.title}\n${res.url}\n\n` : `${res.url}\n\n`;
    const body = res.text || '(the page had no readable text)';
    return {
      output: truncateOutput(head + body, ctx.config.maxToolChars),
      display: res.title ? truncateForDisplay(res.title, 40) : `${body.length} 文字`
    };
  }
};

// ── ログイン済みのブラウザでページを開く ─────────────────────
//
// web_fetch との違いは2つ。
//   ・保存したログイン状態を使うので、ログインが要るページも読める
//   ・JavaScript で描くページも、描き終わった中身が読める
// そのぶん重い（ブラウザを起こす）ので、web_fetch で足りるならそちらを使わせる。
const browseTool = {
  name: 'browse',
  approval: 'always',
  description:
    "Open a page in the user's real browser, which keeps their saved logins, and return the visible text. " +
    'Use it when web_fetch failed, when the page needs a login, when the content is rendered by JavaScript, ' +
    'or for a local development server. Prefer web_fetch for plain public pages: it is much faster.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to open.' }
    },
    required: ['url']
  },
  approvalTitle() {
    return 'ログイン済みのブラウザでページを開きます';
  },
  preview(args) {
    return (
      `${c.cyan(`  ${String(args.url || '').slice(0, 300)}`)}\n` +
      `${c.gray('  保存済みのログイン状態が使われます')}`
    );
  },
  async run(args, ctx) {
    if (ctx.config.net === false) {
      return { isError: true, output: 'Web access is disabled (--no-net).', display: 'ネット接続は切られています' };
    }
    const res = await browse(args.url, {
      timeoutMs: ctx.config.browseTimeoutMs,
      maxChars: ctx.config.maxToolChars
    });
    if (!res.ok) return { isError: true, output: res.reason, display: '開けませんでした' };

    const head = res.title ? `# ${res.title}\n${res.url}\n\n` : `${res.url}\n\n`;
    const body = res.text || '(the page showed no text)';
    return {
      output: truncateOutput(head + body, ctx.config.maxToolChars),
      display: res.title ? truncateForDisplay(res.title, 40) : `${body.length} 文字`
    };
  }
};

// ── ブラウザログイン ──────────────────────────────────────────
//
// ログインは人がやる。道具にできるのは「窓を開けること」と「閉じて保存すること」だけ。
// モデルの呼び出しは1回で返さないといけないので、開けると閉じるを2回に分けてある。
const browserLoginTool = {
  name: 'browser_login',
  approval: 'always',
  description:
    'Open a real browser so the USER can log in to a site by hand. You never type credentials. ' +
    'Call it with a url to open the window. When the user says they are done, call it again with done=true ' +
    'to close the window and keep the login. After that, browse can read pages on that site.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The site to log in to, e.g. https://github.com' },
      done: { type: 'boolean', description: 'Set to true once the user says the login is finished.' }
    }
  },
  approvalTitle(args) {
    return args?.done ? 'ログイン状態を保存します' : 'ブラウザでログインします';
  },
  preview(args) {
    if (args?.done) return c.gray('  開いているブラウザを閉じて、ログイン状態を保存します');
    return (
      `${c.cyan(`  ${String(args?.url || '').slice(0, 300)}`)}\n` +
      `${c.gray('  ブラウザを開きます。入力はあなたの手で行ってください。')}`
    );
  },
  async run(args, ctx) {
    if (ctx.config.net === false) {
      return { isError: true, output: 'Web access is disabled (--no-net).', display: 'ネット接続は切られています' };
    }

    if (args.done) {
      const res = await finishLogin();
      if (!res.ok) return { isError: true, output: res.reason, display: '開いていません' };
      return {
        output: `Saved the login for ${res.host} (${res.cookieCount} cookies). browse can now read pages there.`,
        display: `${res.host} を保存`
      };
    }

    if (!args.url) {
      return { isError: true, output: 'url is required (or pass done=true to finish).', display: 'URLがありません' };
    }
    const res = await openForLogin(args.url);
    if (!res.ok) return { isError: true, output: res.reason, display: '開けませんでした' };
    return {
      output:
        `A browser window is open at ${res.host}. Tell the user to log in there by hand, ` +
        'then wait for them to say they are done. When they do, call this tool again with done=true. ' +
        'Do not ask them for their password.',
      display: `${res.host} を開きました`
    };
  }
};

// ── やることリスト ───────────────────────────────────────────
//
// 何かを変えるわけではなく、頭の中の予定を紙に書き出させるだけの道具。
// 小さいモデルは3手を超えると途中で目的を見失うので、
// 「次に何をするか」を毎回自分で読み直せる場所を作る。
//
// 呼ぶたびに全部を置き換える。差分で足していく形にすると、
// モデルが前の内容を思い出せずに壊す。
const todoWrite = {
  name: 'todo_write',
  approval: 'never',
  description:
    'Record or update your task list for the current request. Pass the COMPLETE list every time — it replaces the previous one. ' +
    'Use it when the work takes three or more steps, right after you understand what is needed. ' +
    'Mark exactly one item as in_progress, and mark it completed as soon as it is done — do not batch the updates. ' +
    'Skip it for single-step requests; it only adds noise there.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full task list, in the order you will do them.',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'What will be done, in one short line.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'pending / in_progress / completed'
            }
          },
          required: ['step', 'status']
        }
      }
    },
    required: ['todos']
  },
  validate(args) {
    if (!Array.isArray(args.todos)) return 'todos must be an array.';
    if (args.todos.length === 0) return 'todos must not be empty. Omit the call instead.';
    if (args.todos.length > 20) return 'Too many steps. Keep the list to 20 or fewer.';
    return null;
  },
  async run(args, ctx) {
    const allowed = new Set(['pending', 'in_progress', 'completed']);
    const todos = args.todos
      .map((t) => ({
        step: String(t?.step ?? '').trim(),
        status: allowed.has(t?.status) ? t.status : 'pending'
      }))
      .filter((t) => t.step);

    if (!todos.length) {
      return { isError: true, output: 'Every item needs a step.', display: '中身が空です' };
    }

    // 手をつけているものは1つだけ。2つ以上あると、どれを進めているのか分からなくなる。
    const running = todos.filter((t) => t.status === 'in_progress');
    if (running.length > 1) {
      for (const t of running.slice(1)) t.status = 'pending';
    }

    ctx.todos = todos;
    renderTodos(todos);
    // 別のアプリの中で動いているときは、そちらの画面にも渡す。
    // 何をどこまでやるつもりなのかは、待っている人がいちばん知りたいこと。
    ctx.config.onTodos?.(todos);

    const done = todos.filter((t) => t.status === 'completed').length;
    const next = todos.find((t) => t.status === 'in_progress') || todos.find((t) => t.status === 'pending');
    return {
      output:
        `Task list updated (${done}/${todos.length} done).\n` +
        todos.map((t, i) => `${i + 1}. [${t.status}] ${t.step}`).join('\n') +
        (next ? `\n\nNext: ${next.step}` : '\n\nAll steps are complete.'),
      display: `${done}/${todos.length} 完了`,
      quiet: true
    };
  }
};

// ── 記号の意味で探す（LSP） ──────────────────────────────────
//
// search_files との違いは「意味で分かっているかどうか」。
// `renderTodos` を文字で探すと、コメントに書かれた説明文まで当たる。
// 言語サーバーは何がその名前を指すか知っているので、本物だけを返す。
// 実測（このリポジトリ）：文字検索7件のうち2件はコメント。LSP は正しく4件だけ返した。
const findSymbol = {
  name: 'find_symbol',
  approval: 'never',
  description:
    'Look up a function, class, or variable by NAME using the language server, which understands the code. ' +
    'operation="definition" finds where it is defined, "references" finds every place that actually uses it, ' +
    '"hover" shows its type and documentation. ' +
    'Prefer this over search_files for code symbols: search_files matches plain text, so it also hits comments, ' +
    'strings, and similar names. Use search_files for text that is not a symbol.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The exact symbol name, e.g. "renderTodos". No parentheses.' },
      operation: {
        type: 'string',
        enum: ['definition', 'references', 'hover'],
        description: 'definition / references / hover. Default is definition.'
      },
      path: { type: 'string', description: 'Optional file to look in, if you already know which one.' }
    },
    required: ['name']
  },
  async run(args, ctx) {
    const name = String(args.name || '').trim().replace(/\(\)$/, '');
    if (!name) return { isError: true, output: 'name is required.', display: '名前が空です' };

    const hint = args.path ? resolveSafe(args.path, ctx) : null;
    const operation = ['definition', 'references', 'hover'].includes(args.operation)
      ? args.operation
      : 'definition';

    let res;
    try {
      if (operation === 'references') res = await findReferences(name, ctx.root, hint);
      else if (operation === 'hover') res = await findHover(name, ctx.root, hint);
      else res = await findDefinition(name, ctx.root, hint);
    } catch (err) {
      return {
        isError: true,
        output: `The language server could not answer: ${err.message}. Use search_files instead.`,
        display: '言語サーバーが応えませんでした'
      };
    }

    if (!res.ok) {
      return {
        isError: true,
        output: `${res.reason} Try search_files if it is not a code symbol.`,
        display: '見つかりません'
      };
    }

    if (operation === 'hover') {
      return {
        output: res.text
          ? `${name} — ${res.place.file}:${res.place.line}\n\n${res.text}`
          : `${name} is at ${res.place.file}:${res.place.line}, but the language server had no type information.`,
        display: res.text ? truncateForDisplay(res.text.split('\n')[0], 40) : '説明なし'
      };
    }

    const places = res.places || [];
    if (!places.length) {
      return {
        output:
          operation === 'references'
            ? `${name} is not used anywhere else in this project.`
            : `Could not resolve where ${name} is defined.`,
        display: '0 件'
      };
    }

    const lines = places.map((p) => `${p.file}:${p.line}  ${p.text}`);
    return {
      output: `${operation === 'references' ? 'Used at' : 'Defined at'}:\n${lines.join('\n')}`,
      display: `${places.length} 件`
    };
  }
};

// ── 調べものを任せる ─────────────────────────────────────────
//
// 読んだファイルの中身は、任された側の会話にだけ残る。
// 本体に返るのは答えの数行だけなので、文脈を食いつぶさずに調べられる。
const spawnAgent = {
  name: 'spawn_agent',
  approval: 'never',
  description:
    'Hand off a self-contained research question to a separate assistant that can only read. ' +
    'It explores on its own and comes back with just the answer, so the files it reads never enter your context. ' +
    'Use it when finding something out would take several reads — "where is X handled", "how does Y flow through the code", ' +
    '"which files would a change to Z touch". ' +
    'Ask one clear question and say what you want back. It cannot change anything, so do not ask it to.',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'The question, written so it stands alone — the assistant sees none of this conversation. ' +
          'Say what to find and what to report back.'
      }
    },
    required: ['task']
  },
  async run(args, ctx) {
    // 入れ子は許さない。木が無限に広がる。
    if (ctx.config.isSubagent) {
      return {
        isError: true,
        output: 'You are already a research assistant. Do the work yourself with the read tools you have.',
        display: '入れ子にはできません'
      };
    }

    const res = await runSubagent({
      task: args.task,
      config: ctx.config,
      root: ctx.root,
      permissions: ctx.permissions,
      signal: ctx.signal
    });

    if (!res.ok) {
      return { isError: true, output: `${res.reason} Investigate it yourself instead.`, display: '戻りませんでした' };
    }
    return {
      output:
        `The research assistant reports:\n\n${res.answer}\n\n` +
        '(It could only read. Verify anything you are about to change by reading the file yourself.)',
      display: `${res.steps} 回調べて回答`,
      quiet: true
    };
  }
};

// ── 手順書を読む ────────────────────────────────────────────
//
// 一覧（名前と一行の説明）は指示文に載せてある。
// 中身は長いので、要ると分かった時点でここから読ませる。
const readSkill = {
  name: 'read_skill',
  approval: 'never',
  description:
    'Read the full text of one of the skills listed in your instructions. ' +
    'A skill is a written procedure for a specific job. ' +
    'When the request matches a skill, read it before doing anything else and follow it.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name, exactly as listed in your instructions.' }
    },
    required: ['name']
  },
  async run(args, ctx) {
    const wanted = String(args.name || '').trim();
    const skills = loadSkills(ctx.root);
    const found = skills.find((s) => s.name === wanted);

    if (!found) {
      // 名前を取り違えただけのことが多いので、実際にあるものを返す
      return {
        isError: true,
        output: skills.length
          ? `No skill named "${wanted}". Available: ${skills.map((s) => s.name).join(', ')}.`
          : 'This project has no skills.',
        display: '見つかりません'
      };
    }
    return {
      output: `--- Skill: ${found.name} ---\n${found.body}`,
      display: `${found.name} を読み込み`
    };
  }
};

/**
 * いま実際に渡す道具を決める。
 *
 * 呼べない道具は最初から見せない。
 * 見せてしまうと、モデルが呼んで失敗し、その理由を考えるのに往復を1回使う。
 */
// つないだ外の道具（MCP）。startMcp が呼ばれるまでは空。
let mcpTools = [];

/** つないだ外の道具を登録する。呼ぶのは起動処理（bin/qwc.mjs）だけ。 */
export function setMcpTools(tools) {
  mcpTools = Array.isArray(tools) ? tools : [];
  for (const tool of mcpTools) TOOL_MAP.set(tool.name, tool);
}

export function activeTools(config = {}) {
  // 別のアプリの中で動いているときは、そのアプリが持っている道具だけを見せる。
  //
  // 呼べない道具を見せない、という考え方は同じ。
  // 違うのは「呼べるかどうか」を決めるのが、こちらではなく相手だという点。
  // 相手が read_file しか持っていないのに write_file を見せれば、
  // モデルは書こうとして断られ、その理由を考えるのに往復を1回使う。
  // やることリストと調べものの委譲は、外に手を出さない道具なので相手の実装が要らない。
  // ここが持ち込める中身でもある（相手は輪と一緒にこの2つも手に入る）。
  if (Array.isArray(config.hostToolNames)) {
    const allowed = new Set([...config.hostToolNames, ...INTERNAL_TOOLS, ...mcpTools.map((t) => t.name)]);
    if (config.isSubagent) {
      // 任された側の扱いは、ここでも本体のときと同じにする。
      // 片方だけ違うと、同じ言葉で頼んだのに動きが変わる。
      allowed.delete('spawn_agent');
      allowed.delete('todo_write');
    }
    return [...TOOLS, ...mcpTools].filter((tool) => allowed.has(tool.name));
  }

  // 計画モードでは、書き換える道具そのものを渡さない。
  // 「使わないでください」と頼むのではなく、無いことにする。
  // 雑談モードも書き換えない点は同じなので、同じ道具立てにする。
  const readOnly = config.planMode || config.chatMode;
  const list = readOnly
    ? [readFile, listDir, searchFiles, runCommand]
    : [readFile, writeFile, editFile, listDir, searchFiles, runCommand];

  // やることリストは人に見せるためのもの。
  // 任された側の画面は本体の作業の途中に挟まって流れるだけなので、渡しても場所を取るだけ。
  // 渡すと「3手以上なら最初に todo_write」の指示に従って往復を1回よけいに使う。
  // 雑談にも渡さない。話しているだけの相手に手順表を出されても困る。
  if (!config.isSubagent && !config.chatMode) list.push(todoWrite);

  // 手順書が1つも無いプロジェクトでは、読む道具そのものを渡さない。
  // 渡すと、モデルは「あるはず」と思って呼び、空振りで往復を1回使う。
  if (config.skillCount > 0) list.push(readSkill);

  // 言語サーバーが1つも入っていなければ渡さない（呼べない道具を見せない）。
  // 読むだけの道具なので、計画モードでも使える。
  // 雑談では渡さない。コードの記号をたどるのは、作業のための道具である。
  if (config.lspReady && !config.chatMode) list.push(findSymbol);

  // 調べものの委譲。ネットは要らないので、切断時でも使える。
  // 任された側には渡さない（入れ子で木が無限に広がるため）。
  // 雑談でも渡さない。任された側は作業の続きを前提に動くので、話が噛み合わない。
  if (!config.isSubagent && !config.chatMode) list.push(spawnAgent);

  // 外の道具は、つないだぶんだけ。設定に書いていなければ1つも増えない。
  list.push(...mcpTools);

  if (config.net === false) return list;
  if (loadApiKey()) list.push(webSearch);
  list.push(webFetch);
  // ブラウザは Playwright が入っているときだけ。
  // 判定は起動時に済ませて config に入れてある（毎回 import を試すと遅い）。
  if (config.browserReady) {
    list.push(browseTool);
    // ログインは人がやる作業だが、モデルから「窓を開ける」ことはできる。
    // 計画モードと雑談モードでは渡さない（画面を開くのは調べる行為ではない）。
    if (!readOnly) list.push(browserLoginTool);
  }
  return list;
}

export const TOOLS = [
  readFile, writeFile, editFile, listDir, searchFiles, runCommand,
  webSearch, webFetch, browseTool, todoWrite, browserLoginTool, findSymbol, spawnAgent, readSkill
];

/**
 * 外に手を出さない道具。
 *
 * 別のアプリの中で動くとき、実体を相手に頼まなくてよいのはこの2つだけ。
 * やることリストは会話の中の覚え書きで、調べものの委譲は qwc をもう1つ動かすだけ。
 * どちらもファイルにもネットにも触れないので、相手の作法を通す必要がない。
 */
export const INTERNAL_TOOLS = ['todo_write', 'spawn_agent', 'read_skill'];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export { KEY_HELP, BROWSER_HELP };

// Ollama へ渡す形（JSON スキーマ）に変換する
export function toolSchemas(config) {
  return activeTools(config || {}).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} }
    }
  }));
}
