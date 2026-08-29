/**
 * harness.mjs — 使ううちに覚えたことの置き場。
 *
 * ■ 何のためにあるのか
 *   毎回まっさらから始めると、同じ失敗を毎回する。
 *   実測でも、9B は存在しないパスを3手ぶん試して24秒を捨てた。
 *   その手の「この作業フォルダではこうする」は、覚えておけば二度払わずに済む。
 *
 * ■ 考え方は prime-agent（PrimeIntellect-ai/prime-agent・MIT）の
 *   Continual Harness から借りている。コードは持ってきていない。借りたのは次の4つ。
 *     1. **基礎の指示文は絶対に書き換えない。**覚えたことは別の層として足すだけ
 *     2. 直すときは、小さな追加・修正・削除にとどめる
 *     3. 1件ずつ「なぜそう言えるのか」を持たせる（根拠なしに覚えない）
 *     4. 当てる前の控えを残し、丸ごと戻せるようにする
 *
 * ■ ここでの制約
 *   覚えたことは毎ターンの入力に必ず乗る＝**固定費**になる。
 *   際限なく増やすと、そのぶん本来の作業に使える枠が減る。
 *   だから件数と長さに上限を置き、超えたら古いものから落とす。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOME_DIR } from './config.mjs';

/** 覚えておける件数（1つの置き場あたり） */
export const MAX_NOTES = 12;

/** 1件の長さ。長い note は読み飛ばされるので、短く言い切らせる */
export const MAX_NOTE_CHARS = 200;

/** 戻すために残す控えの数 */
const MAX_SNAPSHOTS = 5;

/**
 * 置き場は2つ。
 *   project … その作業フォルダだけの話（`.qwythos/harness.json`）
 *   global  … どの作業でも当てはまる話（`~/.qwythos-code/harness.json`）
 * 迷ったら project に入れる。全体に効かせるのは、本当に一般的なことだけ。
 */
export function harnessPaths(root) {
  return {
    project: path.join(root, '.qwythos', 'harness.json'),
    global: path.join(HOME_DIR, 'harness.json')
  };
}

function readStore(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
    // 壊れた行が混ざっていても、読めるものだけで動く（覚え書きのために作業を止めない）
    return notes.filter((n) => n && typeof n.id === 'string' && typeof n.text === 'string');
  } catch {
    return [];
  }
}

function writeStore(file, notes, snapshots) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { version: 1, notes, snapshots: snapshots.slice(-MAX_SNAPSHOTS) };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function readSnapshots(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.snapshots) ? parsed.snapshots : [];
  } catch {
    return [];
  }
}

/** 両方の置き場を読む */
export function loadHarness(root) {
  const paths = harnessPaths(root);
  return { project: readStore(paths.project), global: readStore(paths.global) };
}

/** 指示文に足す節。覚えたことが1つも無ければ、1文字も足さない（固定費を払わない） */
export function harnessBlock(harness) {
  const lines = [];
  const put = (notes, label) => {
    if (!notes.length) return;
    lines.push(`### ${label}`);
    for (const n of notes) lines.push(`- ${n.text}`);
  };
  put(harness.project, 'About this project');
  put(harness.global, 'General');
  if (!lines.length) return '';

  return (
    '\n## What you learned earlier\n' +
    'These are notes from previous sessions on this machine. They are hints, not rules:\n' +
    'if what you see in the files disagrees with a note, trust the files and say so.\n' +
    `${lines.join('\n')}\n`
  );
}

/** 覚えたことを1行にまとめる（画面に出すとき用） */
export function describeHarness(harness) {
  const p = harness.project.length;
  const g = harness.global.length;
  if (!p && !g) return '覚えていることはまだありません。';
  return `覚えていること: このフォルダ ${p} 件 / 全体 ${g} 件`;
}

function newId() {
  return Math.random().toString(36).slice(2, 8);
}

function trim(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > MAX_NOTE_CHARS ? `${one.slice(0, MAX_NOTE_CHARS - 1)}…` : one;
}

/**
 * 小さな差し引きを当てる。
 *
 * 受け取る形: `{ op: 'create' | 'update' | 'delete', scope, id?, text?, evidence? }`
 * 当てる前の中身を控えに残すので、`undoHarness` で丸ごと戻せる。
 *
 * 分からない指示は黙って捨てる。覚え書きのために作業を止めない。
 */
export function applyHarnessEdits(root, edits) {
  const paths = harnessPaths(root);
  const applied = [];

  for (const scope of ['project', 'global']) {
    const mine = (edits || []).filter((e) => e && e.scope === scope);
    if (!mine.length) continue;

    const file = paths[scope];
    const before = readStore(file);
    const snapshots = readSnapshots(file);
    let notes = [...before];

    for (const edit of mine) {
      const op = edit.op;
      if (op === 'create') {
        const text = trim(edit.text);
        if (!text) continue;
        // 同じことを二重に覚えない
        if (notes.some((n) => n.text === text)) continue;
        notes.push({
          id: newId(),
          text,
          evidence: trim(edit.evidence) || '（根拠の記載なし）',
          created: new Date().toISOString().slice(0, 10)
        });
        applied.push({ op, scope, text });
      } else if (op === 'update') {
        const target = notes.find((n) => n.id === edit.id);
        const text = trim(edit.text);
        if (!target || !text) continue;
        target.text = text;
        if (edit.evidence) target.evidence = trim(edit.evidence);
        target.updated = new Date().toISOString().slice(0, 10);
        applied.push({ op, scope, text });
      } else if (op === 'delete') {
        const target = notes.find((n) => n.id === edit.id);
        if (!target) continue;
        notes = notes.filter((n) => n.id !== edit.id);
        applied.push({ op, scope, text: target.text });
      }
    }

    if (!applied.some((a) => a.scope === scope)) continue;

    // 上限を超えたら古いものから落とす。覚えたことは毎ターンの固定費になるため。
    if (notes.length > MAX_NOTES) notes = notes.slice(notes.length - MAX_NOTES);

    snapshots.push({ at: new Date().toISOString(), notes: before });
    writeStore(file, notes, snapshots);
  }

  return applied;
}

/** 直前の変更を取り消す。戻せた置き場の名前を返す */
export function undoHarness(root) {
  const paths = harnessPaths(root);
  const undone = [];
  for (const scope of ['project', 'global']) {
    const file = paths[scope];
    const snapshots = readSnapshots(file);
    const last = snapshots.pop();
    if (!last) continue;
    writeStore(file, last.notes, snapshots);
    undone.push(scope);
  }
  return undone;
}

/**
 * いまのやり取りを見直させて、差し引きを出させるための指示文。
 *
 * **何でも覚えさせないことが要点。**「次はこうする」の類を無制限に足すと、
 * 毎ターンの固定費だけが増えて、当たらない思い込みが積み上がる。
 * だから「実際に起きたことだけ」「一般化できることだけ」に絞らせる。
 */
export const REFINE_PROMPT = `You are reviewing a coding session to update a small set of durable notes.

The notes are hints shown to the agent at the start of every future session on this machine.
They are NOT the agent's instructions — you cannot change how it behaves in general.
You are only recording facts that were expensive to discover and will be true again.

Return ONLY a JSON object, no prose, in this shape:
{"edits":[{"op":"create","scope":"project","text":"...","evidence":"..."}]}

- op: "create" | "update" | "delete"   (update and delete need "id")
- scope: "project" (true only for this codebase) or "global" (true anywhere)
- text: one short sentence, imperative or factual, under 200 characters
- evidence: what in THIS session proves it, as one plain sentence.
  **Do not quote code, commands, JSON, or tool calls inside it.** Describe them in words.
  Write: テストを実際に走らせて成功した — not: run_command({"command":"..."})
  Quotation marks inside these fields break the response and the whole update is thrown away.

The bar is high: a note earns its place only if it SAVES TOOL CALLS next time.
Ask yourself "would the agent waste steps without this?" If not, do not record it.

Record only:
- how to do something in this project that took work to figure out
  (the command that runs its tests, the build step, a config that must be set)
- a mistake that actually happened here and would happen again
  (a path shape that failed, a tool argument that was rejected)

Never record:
- **what a file contains, or what a function does.** Reading the file again costs one call.
  Paying for that description in every future session costs far more.
- anything the transcript does not show. No guesses, no advice, no restating the general rules
- one-off details of this particular request
- anything already covered by an existing note

Write each "text" and "evidence" in the language the user is speaking in this session.
If the user writes in Japanese, write the notes in Japanese.

If nothing in this session meets the bar, return {"edits":[]}. That is the normal answer,
and it is the right answer for most sessions. An empty list is a good outcome, not a failure.`;
