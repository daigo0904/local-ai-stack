// 画面表示まわり。色付け・スピナー・差分表示・簡易マークダウン。
import process from 'node:process';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code) {
  return (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  italic: paint('3'),
  underline: paint('4'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  white: paint('37'),
  gray: paint('90'),
  brightGreen: paint('92'),
  brightRed: paint('91'),
  brightYellow: paint('93'),
  brightCyan: paint('96')
};

// 画面の書き換え（カーソル移動）はターミナル相手のときだけ使える
export const supportsAnsi = useColor;

export function clearLine() {
  if (useColor) target.write('\r\x1b[2K');
}

// 出力の左に付ける印。
//
// サブエージェントが動いているあいだ、その出力を一段下げて見せるために使う。
// 誰がしゃべっているのか分からないまま道具の実行が流れると、
// 利用者は「本体が勝手なことを始めた」と受け取ってしまう。
let outputPrefix = '';

export function setOutputPrefix(prefix = '') {
  outputPrefix = prefix;
}

// 表示の行き先。
//
// 別のアプリの中でエンジンとして動くとき、標準出力は JSON のやりとりに使う。
// 色つきの表示が1文字でも混ざると、相手はその行を読めなくなる。
// かといって捨ててしまうと、うまく動かないときに何も分からない。
// そこで**標準エラーに寄せる**。相手は読み飛ばしてもよいし、記録に取ってもよい。
let target = process.stdout;

export function sendDisplayToStderr() {
  target = process.stderr;
}

export function out(s = '') {
  target.write(outputPrefix && s ? outputPrefix + s : s);
}

export function line(s = '') {
  if (!outputPrefix) return void target.write(`${s}\n`);
  // 複数行でも、行ごとに印を付ける
  const body = String(s)
    .split('\n')
    .map((l) => outputPrefix + l)
    .join('\n');
  target.write(`${body}\n`);
}

export function termWidth() {
  return process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 80;
}

// ── スピナー ────────────────────────────────────────────────
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  constructor(text = '考え中') {
    this.text = text;
    this.timer = null;
    this.index = 0;
    this.startedAt = 0;
    this.active = false;
    // 待たせているあいだに添える一言（経過秒を受け取って文字列を返す）。
    // 何秒経ったかだけでは「進んでいるのか固まったのか」が分からない。
    this.hintFn = null;
  }

  /** 経過秒を見て、そのとき出したい一言を返す関数を登録する。 */
  hint(fn) {
    this.hintFn = typeof fn === 'function' ? fn : null;
    return this;
  }

  start(text) {
    if (text) this.text = text;
    if (!useColor || this.active) return this;
    this.active = true;
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      const elapsed = (Date.now() - this.startedAt) / 1000;
      const sec = elapsed.toFixed(0);
      const frame = FRAMES[this.index++ % FRAMES.length];
      let tail = '';
      try {
        tail = this.hintFn ? String(this.hintFn(elapsed) || '') : '';
      } catch {
        tail = ''; // 一言のために本編を止めない
      }
      process.stdout.write(`\r\x1b[2K${c.magenta(frame)} ${c.gray(`${this.text} (${sec}s)${tail}`)}`);
    }, 90);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  update(text) {
    this.text = text;
    return this;
  }

  stop() {
    if (!this.active) return this;
    clearInterval(this.timer);
    this.timer = null;
    this.active = false;
    process.stdout.write('\r\x1b[2K');
    return this;
  }
}

// ── プログレスバー ──────────────────────────────────────────
export class ProgressBar {
  constructor(label, total = 100) {
    this.label = label;
    this.total = total;
    this.current = 0;
    this.timer = null;
    this.active = false;
  }

  start() {
    if (!useColor || this.active) return this;
    this.active = true;
    this.timer = setInterval(() => this.update(), 100);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  update() {
    const pct = Math.min(100, Math.round((this.current / this.total) * 100));
    const barLen = Math.floor(pct / 2);
    const bar = '█'.repeat(barLen) + '░'.repeat(50 - barLen);
    process.stdout.write(`\r\x1b[2K${c.cyan('●')} ${this.label.padEnd(20)} [${bar}] ${pct}%`);
    return this;
  }

  finish() {
    if (!this.active) return this;
    clearInterval(this.timer);
    this.timer = null;
    this.active = false;
    process.stdout.write('\r\x1b[2K');
    return this;
  }

  set(value) {
    this.current = Math.min(this.total, value);
    return this;
  }
}

// ── 表示部品 ────────────────────────────────────────────────
export function banner(cfg, root) {
  const w = Math.min(termWidth(), 72);
  const bar = '─'.repeat(w - 2);
  line();
  line(c.magenta(`╭${bar}╮`));
  const title = ` ${c.bold('Qwythos Code')} ${c.gray('— ローカルで動く自律コーディング相棒')}`;
  line(`${c.magenta('│')}${title}`);
  line(`${c.magenta('│')} ${c.gray(`モデル: ${cfg.model}   接続先: ${cfg.host}`)}`);
  line(`${c.magenta('│')} ${c.gray(`作業フォルダ: ${root}`)}`);
  line(c.magenta(`╰${bar}╯`));
  line(c.gray('  /help でコマンド一覧、そのまま日本語でお願いを書いてEnter。'));
  line();
}

export function toolHeader(name, summary) {
  line(`${c.brightCyan('●')} ${c.bold(name)}${summary ? c.gray(`(${summary})`) : ''}`);
}

export function toolResultLine(text, isError = false) {
  const mark = isError ? c.red('⎿') : c.gray('⎿');
  const body = isError ? c.red(text) : c.gray(text);
  line(`  ${mark} ${body}`);
}

export function info(text) {
  line(c.gray(`  ${text}`));
}

export function warn(text) {
  line(c.yellow(`  ! ${text}`));
}

export function error(text) {
  line(c.red(`  × ${text}`));
}

export function success(text) {
  line(c.green(`  ✓ ${text}`));
}

/**
 * やることリストを描く。
 *
 * 毎回ぜんぶ出し直す（差分だけ出すと、何が残っているか分からなくなる）。
 * いま手をつけているものだけ色を付けて、目が1行に留まるようにする。
 */
export function renderTodos(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return;
  const done = todos.filter((t) => t.status === 'completed').length;
  line();
  line(`${c.brightCyan('●')} ${c.bold('やること')} ${c.gray(`(${done}/${todos.length})`)}`);
  for (const t of todos) {
    if (t.status === 'completed') {
      line(`  ${c.green('☑')} ${c.gray(strikethrough(t.step))}`);
    } else if (t.status === 'in_progress') {
      line(`  ${c.brightYellow('▸')} ${c.bold(t.step)}`);
    } else {
      line(`  ${c.gray('☐')} ${t.step}`);
    }
  }
  line();
}

// 取り消し線。使えない端末では色だけで区別が付くので、そのまま返す。
function strikethrough(text) {
  return useColor ? `\x1b[9m${text}\x1b[29m` : text;
}

// ── かかった時間の内訳 ──────────────────────────────────────
//
// ■ なぜ分けて出すか
//   ローカルのモデルは、待ち時間の大半が**生成ではないところ**で消える。
//   モデルの読み込み（初回は分単位）と、送った会話を読む前処理（毎ターン payable）が
//   合わさって「なぜか今日は遅い」になる。ひとまとめの秒数だけ見せても、
//   広げすぎた文脈が原因なのか、モデルが載り切っていないのかを切り分けられない。
//
// ■ いつ出すか
//   速いときは出さない。1手が2秒で終わる作業に毎回内訳が付くと、ただの雑音になる。

/** これより短い応答には内訳を出さない（ミリ秒）。 */
export const TIMING_FLOOR_MS = 2000;

export function formatTiming(stats = {}) {
  const total = stats.totalMs || 0;
  if (!total || total < TIMING_FLOOR_MS) return '';

  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const parts = [];
  // 読み込みは、起きたときだけ出す（常駐していれば 0 になる）
  if ((stats.loadMs || 0) >= 100) parts.push(`読み込み ${secs(stats.loadMs)}`);
  if ((stats.promptMs || 0) >= 100) {
    const tokens = stats.promptTokens ? `・${stats.promptTokens.toLocaleString()} tok` : '';
    parts.push(`前処理 ${secs(stats.promptMs)}${tokens}`);
  }
  if ((stats.evalMs || 0) >= 100) {
    const speed = stats.outputTokens && stats.evalMs
      ? `・${(stats.outputTokens / (stats.evalMs / 1000)).toFixed(1)} tok/s`
      : '';
    parts.push(`生成 ${secs(stats.evalMs)}${speed}`);
  }
  if (!parts.length) return '';
  return `⏱ ${secs(total)}  ${parts.join(' / ')}`;
}

// ── 差分表示 ────────────────────────────────────────────────
// 前後の共通部分を削って、変わったところだけを見せる素朴な差分。
export function renderDiff(oldText, newText, contextLines = 3) {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);

  if (removed.length === 0 && added.length === 0) {
    return c.gray('  (内容の変化はありません)');
  }

  const lines = [];
  const preFrom = Math.max(0, start - contextLines);
  for (let i = preFrom; i < start; i++) {
    lines.push(c.gray(`  ${String(i + 1).padStart(4)}  ${a[i]}`));
  }
  removed.forEach((text, i) => {
    lines.push(c.red(`  ${String(start + i + 1).padStart(4)} -${text}`));
  });
  added.forEach((text, i) => {
    lines.push(c.green(`  ${String(start + i + 1).padStart(4)} +${text}`));
  });
  const postTo = Math.min(a.length, endA + 1 + contextLines);
  for (let i = endA + 1; i < postTo; i++) {
    lines.push(c.gray(`  ${String(i + 1).padStart(4)}  ${a[i]}`));
  }

  const MAX = 40;
  if (lines.length > MAX) {
    const head = lines.slice(0, MAX - 5);
    const omitted = lines.length - MAX + 5;
    head.push(c.gray(`  … 表示しきれない ${omitted} 行は省略`));
    return head.join('\n');
  }
  return lines.join('\n');
}

// ── 簡易マークダウン ────────────────────────────────────────
// 返答をターミナルで読みやすくする程度の軽い整形。
export function formatMarkdown(text) {
  const lines = text.split('\n');
  const result = [];
  let inFence = false;

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      const lang = raw.replace(/^\s*```/, '').trim();
      result.push(c.gray(inFence && lang ? `  ┌─ ${lang}` : '  └─'));
      continue;
    }
    if (inFence) {
      result.push(c.cyan(`  │ ${raw}`));
      continue;
    }
    let s = raw;
    s = s.replace(/`([^`]+)`/g, (_, code) => c.cyan(code));
    s = s.replace(/\*\*([^*]+)\*\*/g, (_, b) => c.bold(b));
    if (/^#{1,6}\s/.test(s)) {
      s = c.bold(c.brightYellow(s.replace(/^#{1,6}\s/, '')));
    } else if (/^\s*[-*]\s/.test(s)) {
      s = s.replace(/^(\s*)[-*]\s/, (_, sp) => `${sp}${c.magenta('•')} `);
    }
    result.push(s);
  }
  return result.join('\n');
}

export function truncateForDisplay(text, maxLines = 12) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n… 他 ${lines.length - maxLines} 行`;
}
