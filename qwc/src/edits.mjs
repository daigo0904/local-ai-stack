// 書き換えの控え。`/undo` で戻し、`/diff` でまとめて見るためのもの。
//
// ■ なぜ要るか
//   書き換えは承認のときに差分が出るが、通り過ぎたあとは追えない。
//   git を使っていないフォルダだと、戻す手立ては本人の記憶しかなかった。
//   「さっきのは無しで」と言えないと、結局こわくて `--accept-edits` を使えない。
//
// ■ 何を控えるか
//   ファイルを書き換えるたびに、その**直前の中身**と**書いた後の中身**を持つ。
//   後の中身まで持つのは、戻すときに「そのあと誰かが触っていないか」を確かめるため。
//   本人が別のエディタで直したものを、こちらが黙って巻き戻してはいけない。
//
// ■ 戻す単位は「1手」ではなく「1回のお願い」
//   モデルは1回のお願いで3ファイルを直すことがある。そのうち1つだけ戻しても、
//   コードは半端な状態で残る。だから同じお願いのぶんをまとめて戻す。
import fs from 'node:fs';

/** 控えとして持つ書き換えの数。これを超えたら古いものから捨てる。 */
export const MAX_ENTRIES = 60;

/**
 * 1ファイルぶんの控えを持つ上限。
 *
 * 中身を丸ごと2つ（前と後）抱えるので、大きなファイルを何度も書き換えられると
 * 会話そのものより控えのほうが重くなる。超えたものは中身を持たず、戻せないと伝える。
 * 黙って戻さないより、戻せないと分かるほうがよい。
 */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** ctx に控えの置き場を用意する（古い ctx でも落ちないように、使う直前に必ず通す）。 */
function ensure(ctx) {
  if (!Array.isArray(ctx.editLog)) ctx.editLog = [];
  if (!(ctx.editBaseline instanceof Map)) ctx.editBaseline = new Map();
  if (typeof ctx.turnSeq !== 'number') ctx.turnSeq = 0;
  return ctx;
}

/** 新しいお願いが始まった。ここから先の書き換えを、ひとまとまりとして数える。 */
export function beginTurn(ctx) {
  if (!ctx) return;
  ensure(ctx);
  ctx.turnSeq += 1;
}

/** 控えを全部捨てる（`/clear` から呼ぶ）。 */
export function resetEdits(ctx) {
  if (!ctx) return;
  ensure(ctx);
  ctx.editLog.length = 0;
  ctx.editBaseline.clear();
  ctx.turnSeq = 0;
}

/**
 * 1回ぶんの書き換えを控える。
 *
 * `before` が null なら、そのファイルは無かった（＝新規作成）。
 * 戻すときは消すことになるので、「中身が無い」と「ファイルが無かった」を
 * 取り違えないよう `existed` で分けて持つ。
 *
 * **あったのに中身を読めなかったとき**は、`existed: true` と `before: null` を渡す。
 * ここを「無かった」と丸めると、`/undo` がファイルごと消しにかかる。
 * 読めないものは、戻せないと伝えて手を出さない。
 */
export function recordEdit(ctx, { path: file, before, after, existed }) {
  if (!ctx || !file) return null;
  ensure(ctx);

  const had = existed === undefined ? before !== null && before !== undefined : Boolean(existed);
  const unreadable = had && (before === null || before === undefined);
  const size = Buffer.byteLength(String(after ?? ''), 'utf8') +
    (had && !unreadable ? Buffer.byteLength(String(before), 'utf8') : 0);
  const big = unreadable || size > MAX_SNAPSHOT_BYTES;

  // そのファイルを最初に触ったときの姿だけは、別に取っておく。
  // 控えは古いものから捨てるので、これが無いと `/diff` の出発点まで消える。
  if (!ctx.editBaseline.has(file)) {
    ctx.editBaseline.set(file, { existed: had, before: big || !had ? null : String(before), big });
  }

  const entry = {
    turn: ctx.turnSeq,
    path: file,
    existed: had,
    before: big || !had ? null : String(before),
    after: big ? null : String(after ?? ''),
    big
  };
  ctx.editLog.push(entry);
  while (ctx.editLog.length > MAX_ENTRIES) ctx.editLog.shift();
  return entry;
}

/** 戻せる書き換えが残っているか。 */
export function canUndo(ctx) {
  return Boolean(ctx && Array.isArray(ctx.editLog) && ctx.editLog.length > 0);
}

/**
 * 直近のお願いでした書き換えを、まとめて元に戻す。
 *
 * ■ 後ろから戻す
 *   同じファイルを2度直していることがある（A→B→C）。
 *   後ろから戻せば C→B、次に B→A となって、正しく最初の姿に帰る。
 *   前から戻すと、1つめを A に戻した直後に2つめが「B のはずだ」と食い違う。
 *
 * ■ そのあと本人が触っていたら、手を出さない
 *   いまディスクにある中身が、こちらが書いた中身と違うなら、間に誰かが入っている。
 *   そこを巻き戻すのは、他人の作業を消すのと同じなので、理由を添えて飛ばす。
 */
export function undoLastTurn(ctx) {
  if (!canUndo(ctx)) return null;
  ensure(ctx);
  const log = ctx.editLog;
  const turn = log[log.length - 1].turn;

  const batch = [];
  while (log.length && log[log.length - 1].turn === turn) batch.push(log.pop());

  // ■ 報告はファイル単位にまとめる
  //   同じファイルを3回直していれば、戻すのも3手になる。
  //   けれど利用者が知りたいのは「どのファイルが、どうなったか」だけで、
  //   同じ名前が3行並んでも、3つの別ファイルと見分けがつかないぶん読みにくくなる。
  //
  // ■ 1度つまずいたファイルは、それ以上さかのぼらない
  //   いまの中身がこちらの書いたものと違う時点で、その手前の姿とも当然合わない。
  //   試すだけ無駄なうえ、同じ理由が並ぶ。
  const restored = new Map();
  const skipped = new Map();
  const failed = new Set();

  for (const e of batch) {
    if (failed.has(e.path)) continue;

    const giveUp = (reason) => {
      failed.add(e.path);
      if (!restored.has(e.path)) skipped.set(e.path, { path: e.path, reason });
    };

    if (e.big) {
      giveUp('書き換える前の中身を控えていません（大きすぎるか、読めない形式）');
      continue;
    }
    let now = null;
    try {
      now = fs.existsSync(e.path) ? fs.readFileSync(e.path, 'utf8') : null;
    } catch (err) {
      giveUp(`読めませんでした（${err.code || err.message}）`);
      continue;
    }
    if (now !== e.after) {
      // 消えているのを「書き換えられています」と言うと、探しても見つからない
      giveUp(now === null ? 'そのあとで消されています' : 'そのあとで別に書き換えられています');
      continue;
    }
    try {
      if (!e.existed) {
        fs.rmSync(e.path, { force: true });
        restored.set(e.path, { path: e.path, removed: true });
      } else {
        fs.writeFileSync(e.path, e.before, 'utf8');
        restored.set(e.path, { path: e.path, removed: false });
      }
    } catch (err) {
      giveUp(err.message);
    }
  }

  // 控えに残っていないファイルは、もう「書き換えたファイル」ではない。
  // ここを直しておかないと、戻したあとの `/files` が嘘をつく。
  for (const file of restored.keys()) {
    if (!log.some((e) => e.path === file)) {
      ctx.changedFiles?.delete(file);
      ctx.editBaseline.delete(file);
    }
  }

  return { turn, restored: [...restored.values()], skipped: [...skipped.values()] };
}

/**
 * このセッションで書き換えたぶんを、最初の姿と「いまのディスクの中身」で並べる。
 *
 * 途中の経過ではなく**通しの差分**を返す。3回直したファイルを3回ぶん見せられても、
 * 結局どうなったのかは分からない。知りたいのは、始める前と今の違いだけ。
 */
export function sessionChanges(ctx, only = null) {
  if (!ctx || !(ctx.editBaseline instanceof Map)) return [];
  const out = [];
  for (const [file, snap] of ctx.editBaseline) {
    if (only && file !== only) continue;
    let after = null;
    let unreadable = false;
    try {
      after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    } catch {
      unreadable = true;
    }
    const before = snap.existed ? snap.before : null;
    out.push({
      path: file,
      before,
      after,
      created: !snap.existed,
      removed: after === null && !unreadable,
      big: snap.big,
      unreadable,
      changed: snap.big || unreadable || before !== after
    });
  }
  return out;
}
