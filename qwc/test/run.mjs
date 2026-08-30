// モデルを使わずに動かせる検証。`npm test` で実行する。
// ここが通らない状態で対話を試しても原因の切り分けができないので、先にこれを通すこと。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_MAP, truncateOutput, OUTPUT_DRAIN_MS } from '../src/tools.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { PermissionManager } from '../src/permissions.mjs';
import { renderDiff } from '../src/ui.mjs';
import { salvageToolCalls, chatStream } from '../src/ollama.mjs';
import {
  describesIntentWithoutActing,
  claimsWorkDone,
  looksLikeFileRewrite,
  recommendsWithoutActing,
  QUIET_AFTER_MS,
  Agent
} from '../src/agent.mjs';
import { TOOLS, activeTools } from '../src/tools.mjs';
import { checkUrl, htmlToText, decodeEntities, extractTitle } from '../src/web.mjs';
import { normalizeUrl, PROFILE_DIR } from '../src/browser.mjs';
import { findMentions, resolveMentions, buildMentionBlock, isImagePath } from '../src/mentions.mjs';
import { stripImages } from '../src/session.mjs';
import { loadCommands, renderCommand, isReserved } from '../src/commands.mjs';
import { pickBestModel, checkGpuFit, GPU_FIT_THRESHOLD } from '../src/ollama.mjs';
import {
  loadHarness,
  harnessBlock,
  applyHarnessEdits,
  undoHarness,
  MAX_NOTES,
  MAX_NOTE_CHARS
} from '../src/harness.mjs';
import { parseEdits } from '../src/agent.mjs';
import { looksLikeComment as looksLikeCommentForTest, serverStatus } from '../src/lsp.mjs';
import { buildSystemPrompt } from '../src/prompt.mjs';
import { classifyInput, SMALL_TALK_HINT, withoutHint } from '../src/smalltalk.mjs';
import { loadSkills, skillsBlock } from '../src/skills.mjs';
import { startMcp, stopMcp } from '../src/mcp.mjs';
import { beginTurn, recordEdit, undoLastTurn, sessionChanges, canUndo, resetEdits } from '../src/edits.mjs';
import { complete, completePath } from '../src/complete.mjs';
import { createPasteBuffer } from '../src/paste.mjs';
import { formatTiming, TIMING_FLOOR_MS } from '../src/ui.mjs';
import { BUILTIN_COMMANDS } from '../src/commands.mjs';
import { makeCompleter } from '../src/complete.mjs';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwc-test-'));
// 検証は「出荷時にどう振る舞うか」を見るものなので、設定は既定値から作る。
//
// ここで loadConfig() を使うと **本人の ~/.qwythos-code/config.json を読んでしまう**。
// 実際 autoApprove を保存したとたん「既定では確認する」等が5件落ちた。
// 毎回コピーを返すのは、どこかで書き換えられても他へ漏れないようにするため。
const baseConfig = () => ({ ...DEFAULT_CONFIG });

const ctx = {
  root,
  config: baseConfig(),
  changedFiles: new Set(),
  readFiles: new Set(),
  signal: null
};

const edit = TOOL_MAP.get('edit_file');
const read = TOOL_MAP.get('read_file');
const list = TOOL_MAP.get('list_dir');
const search = TOOL_MAP.get('search_files');
const write = TOOL_MAP.get('write_file');
const run = TOOL_MAP.get('run_command');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  NG   ${name}${detail ? `\n       ${String(detail).slice(0, 300)}` : ''}`);
  }
};
const put = (name, body) => {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
  return p;
};
const get = (name) => fs.readFileSync(path.join(root, name), 'utf8');

console.log('\nedit_file — 置き換えの正しさ');
{
  put('a.js', 'function f() {\n  return 1;   \n}\n');
  let r = await edit.run({ path: 'a.js', old_string: '  return 1;', new_string: '  return 2;' }, ctx);
  check('行末の空白のズレを吸収する', !r.isError && get('a.js').includes('return 2;'), r.output);

  put('b.js', 'class A {\n    method() {\n        return 1;\n    }\n}\n');
  r = await edit.run(
    { path: 'b.js', old_string: 'method() {\n    return 1;\n}', new_string: 'method() {\n    return 42;\n}' },
    ctx
  );
  check('一律にずれた字下げを補正する', get('b.js').includes('        return 42;') && get('b.js').includes('    method() {'), get('b.js'));

  put('c.js', 'let x = 1;\nlet x = 1;\n');
  r = await edit.run({ path: 'c.js', old_string: 'let x = 1;', new_string: 'let x = 2;' }, ctx);
  check('複数一致は拒否する', r.isError && /appears 2 times/.test(r.output), r.output);

  r = await edit.run({ path: 'c.js', old_string: 'let x = 1;', new_string: 'let x = 2;', replace_all: true }, ctx);
  check('replace_all なら全部置き換える', get('c.js') === 'let x = 2;\nlet x = 2;\n', get('c.js'));

  // まったく似ていないものを送ってきたとき。
  // 「近い場所はここです」と嘘をつかず、別のファイルを見ている可能性を伝える
  r = await edit.run({ path: 'c.js', old_string: 'nope', new_string: 'x' }, ctx);
  check(
    '似た場所が無ければ、読み直させる',
    r.isError && /nothing in it resembles/.test(r.output) && /let x = 2;/.test(r.output),
    r.output
  );

  // ── 一致しなかったとき、狙った場所の現物を返す ──────────────
  //
  // ここで先頭80行を返していたせいで、長いファイルでは狙った場所が入っておらず、
  // モデルが手がかりの無いまま推測を繰り返して無限に往復した（実機 Sidebar.tsx）。
  {
    const body = [];
    for (let i = 1; i <= 120; i++) body.push(`  const line${i} = ${i};`);
    body.splice(99, 0, '  return (', '    <div className="sidebar">', '      <span>ここ</span>', '    </div>', '  );');
    put('long.tsx', `${body.join('\n')}\n`);

    // 100行目より後ろを、少しずれた形で狙う
    r = await edit.run(
      {
        path: 'long.tsx',
        old_string: '  return (\n    <div className="sidebar">\n      <span>ちがう</span>\n    </div>\n  );',
        new_string: 'x'
      },
      ctx
    );
    check('遠い場所でも、狙った付近を返す', r.isError && /<span>ここ<\/span>/.test(r.output), r.output.slice(0, 200));
    check('どのあたりかを行番号で伝える', /closest place is around line 1\d\d/.test(r.output), r.output.slice(0, 200));
    check('先頭を返さない', !/const line1 = 1;/.test(r.output), r.output.slice(0, 200));
  }

  // ── 同じファイルで続けて失敗したら、やり方を変えさせる ────────
  //
  // 引数が毎回わずかに違うので、同じ呼び出しを止める仕掛けでは捕まらない。
  {
    put('loop.js', 'const a = 1;\nconst b = 2;\n');
    const fresh = { ...ctx, editFailures: new Map() };

    const first = edit.validate({ path: 'loop.js', old_string: 'const a = 9;', new_string: 'x' }, fresh);
    check('1回目は、まだやり方を変えさせない', !/Stop using edit_file/.test(first), first.slice(0, 120));

    const second = edit.validate({ path: 'loop.js', old_string: 'const a = 8;', new_string: 'x' }, fresh);
    check('2回続けて外したら、丸ごと書き直させる', /Stop using edit_file/.test(second), second.slice(0, 160));
    check('そのとき現物の全文を渡す', /const a = 1;\nconst b = 2;/.test(second));

    // 通ったら数えは消える。次に詰まったときは、また最初から
    edit.validate({ path: 'loop.js', old_string: 'const a = 1;', new_string: 'const a = 3;' }, fresh);
    const afterOk = edit.validate({ path: 'loop.js', old_string: 'const a = 7;', new_string: 'x' }, fresh);
    check('一度通れば、数えは振り出しに戻る', !/Stop using edit_file/.test(afterOk), afterOk.slice(0, 120));

    // 長すぎるファイルを丸ごと書き直させると、別の壊し方になる
    const big = [];
    for (let i = 0; i < 500; i++) big.push(`const v${i} = ${i};`);
    put('big.js', `${big.join('\n')}\n`);
    const bigCtx = { ...ctx, editFailures: new Map() };
    edit.validate({ path: 'big.js', old_string: 'nope1', new_string: 'x' }, bigCtx);
    const bigSecond = edit.validate({ path: 'big.js', old_string: 'nope2', new_string: 'x' }, bigCtx);
    check('長すぎるファイルは丸ごと書き直させない', !/Stop using edit_file/.test(bigSecond) && /offset and limit/.test(bigSecond), bigSecond.slice(0, 160));
  }

  put('d.js', 'export function sum(a, b) {\n  return a + b;\n}\n');
  r = await edit.run(
    {
      path: 'd.js',
      old_string: '    1\texport function sum(a, b) {\n    2\t  return a + b;\n    3\t}',
      new_string: '    1\texport function sum(a, b) {\n    2\t  return a + b;\n    3\t}\n    4\t\n    5\texport function multiply(a, b) {\n    6\t  return a * b;\n    7\t}'
    },
    ctx
  );
  check('read_file の行番号ごと貼られても救済する', !r.isError && get('d.js').includes('return a * b;') && !get('d.js').includes('\t'), r.output);

  put('e.tsv', '1\tapple\n2\tbanana\n');
  r = await edit.run({ path: 'e.tsv', old_string: '2\tbanana', new_string: '2\tcherry' }, ctx);
  check('行番号に見えるタブ区切りデータを壊さない', !r.isError && get('e.tsv') === '1\tapple\n2\tcherry\n', get('e.tsv'));

  put('f.js', 'const x = 1;\n');
  r = await edit.run({ path: 'f.js', old_string: 'const x = 1;\n', new_string: 'const x = 1;\nconst y = 2;\n' }, ctx);
  check('末尾への追記ができる', !r.isError && get('f.js') === 'const x = 1;\nconst y = 2;\n', get('f.js'));

  r = await edit.run({ path: 'f.js', old_string: 'const y = 2;', new_string: 'const y = 2;' }, ctx);
  check('中身が変わらない編集は断る', r.isError && /identical/.test(r.output), r.output);

  check('確認前の検査が不一致を見つける', edit.validate({ path: 'f.js', old_string: 'zzz', new_string: 'y' }, ctx) !== null);
  check('確認前の検査は成立する編集を通す', edit.validate({ path: 'f.js', old_string: 'const y = 2;', new_string: 'const y = 3;' }, ctx) === null);
}

console.log('\nパスの扱い');
{
  put('src/deep.js', 'x\n');
  let r = await read.run({ path: 'wrong/place/deep.js' }, ctx);
  check('取り違えたパスに候補を出す', r.isError && /Did you mean/.test(r.output) && /src\/deep\.js/.test(r.output), r.output);

  r = await read.run({ path: 'nowhere.xyz' }, ctx);
  check('候補が無ければ作業フォルダの中身を教える', r.isError && /workspace root/.test(r.output), r.output);

  let threw = null;
  try {
    await read.run({ path: '../../../etc/hosts' }, ctx);
  } catch (err) {
    threw = err;
  }
  check('作業フォルダの外は読めない', threw !== null && /作業フォルダ/.test(threw.message), threw?.message);

  threw = null;
  try {
    await write.run({ path: '/tmp/qwc-should-not-exist.txt', content: 'x' }, ctx);
  } catch (err) {
    threw = err;
  }
  check('作業フォルダの外へは書けない', threw !== null && !fs.existsSync('/tmp/qwc-should-not-exist.txt'), threw?.message);
}

console.log('\n読み取り系のツール');
{
  put('long.txt', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  let r = await read.run({ path: 'long.txt', offset: 10, limit: 3 }, ctx);
  check('offset と limit が効く', /line 10/.test(r.output) && /line 12/.test(r.output) && !/line 13\b/.test(r.output), r.output);

  put('bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x00]).toString('binary'));
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  r = await read.run({ path: 'bin.dat' }, ctx);
  check('バイナリは読まずに断る', r.isError && /binary/.test(r.output), r.output);

  r = await list.run({ path: '.' }, ctx);
  check('フォルダ一覧が返る', !r.isError && /src\//.test(r.output), r.output);

  put('hay/needle.js', 'const findMe = 42;\n');
  r = await search.run({ pattern: 'findMe', path: '.' }, ctx);
  check('横断検索で見つけられる', !r.isError && /needle\.js/.test(r.output) && /findMe/.test(r.output), r.output);

  r = await search.run({ pattern: 'zzz_not_present_zzz', path: '.' }, ctx);
  check('見つからない場合はその旨を返す', /No matches/.test(r.output), r.output);
}

console.log('\nコマンド実行');
{
  let r = await run.run({ command: 'echo hello' }, ctx);
  check('標準出力を拾う', !r.isError && /hello/.test(r.output), r.output);

  r = await run.run({ command: 'exit 3' }, ctx);
  check('失敗の終了コードを伝える', r.isError && /Exit code: 3/.test(r.output), r.output);

  r = await run.run({ command: 'sleep 5', timeout_ms: 400 }, ctx);
  check('時間切れで打ち切る', /timed out/.test(r.output), r.output);
}

console.log('\n確認が要るコマンドの判定');
{
  const perms = new PermissionManager(baseConfig(), async () => 'n');
  const cases = [
    ['ls -la', true], ['git status', true], ['pwd', true], ['cat README.md', true],
    ['rm -rf /', false], ['npm test', false], ['git push', false],
    ['cat a.txt > b.txt', false], ['ls; rm -rf x', false], ['git log | head', false],
    ['echo `whoami`', false], ['cat $(ls)', false]
  ];
  let ok = true;
  const wrong = [];
  for (const [cmd, want] of cases) {
    if (perms.isSafeCommand(cmd) !== want) {
      ok = false;
      wrong.push(cmd);
    }
  }
  check(`読み取り専用かどうかを ${cases.length} 件すべて正しく判定する`, ok, wrong.join(' / '));
}

// ── 長すぎる出力の切り詰め ──────────────────────────────────
console.log('\n長すぎる出力の切り詰め');
{
  const long = 'あ'.repeat(5000);
  const cut = truncateOutput(long, 1000);
  check('短ければ触らない', truncateOutput('みじかい', 1000) === 'みじかい');
  check('前と後ろを残す', cut.startsWith('あ') && cut.endsWith('あ'));
  check('省略した文字数を言う', cut.includes('4000 characters omitted'), cut.slice(0, 60));
  // ここが弱いと、前の3分の1だけを見て「該当は2つです」と答えてしまう（実測）
  check('全部ではないと分かる書き方にする', cut.includes('THIS IS NOT THE WHOLE OUTPUT'));
  check('次の手も書いてある', cut.includes('offset/limit'));
}

console.log('\n本文に書かれた道具呼び出しの救済');
{
  // qwen2.5-coder のように、決められたタグを付けずに JSON をそのまま本文へ書くモデルがある。
  // 拾えないと道具が永遠に呼ばれない。逆に拾いすぎると、ふつうの文章を誤って実行してしまう。
  const tools = [{ function: { name: 'run_command' } }, { function: { name: 'read_file' } }];
  const salvage = (text) => salvageToolCalls(text, tools);

  let r = salvage('{"name": "run_command", "arguments": {"command": "npm test"}}');
  check('裸のJSONを拾う', r.calls.length === 1 && r.calls[0].args.command === 'npm test', JSON.stringify(r));

  r = salvage('直します。\n```json\n{"name":"read_file","arguments":{"path":"a.js"}}\n```');
  check('jsonフェンスの中を拾う', r.calls.length === 1 && r.calls[0].args.path === 'a.js', JSON.stringify(r));

  r = salvage('<tool_call>{"name":"run_command","arguments":{"command":"ls"}}</tool_call>');
  check('tool_callタグの中を拾う', r.calls.length === 1, JSON.stringify(r));

  r = salvage('[{"name":"read_file","arguments":{"path":"a"}},{"name":"read_file","arguments":{"path":"b"}}]');
  check('配列で複数書かれても拾う', r.calls.length === 2, JSON.stringify(r));

  r = salvage('sum.js の引き算を足し算に直しました。');
  check('ふつうの文章は拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage('{"name":"delete_everything","arguments":{}}');
  check('知らない道具名は拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage('設定は {"name": "foo"} のように書きます。');
  check('文章中のJSONは拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage('やります。\n<tool_call>{"name":"run_command","arguments":{"command":"ls"}}</tool_call>');
  check('拾った部分は本文から取り除く', r.calls.length === 1 && r.cleaned === 'やります。', JSON.stringify(r));

  // 関数を書くような形で本文に書く癖。qwythos 9B に道具の名前を出して頼むと、こうなる
  const withArgs = [
    { function: { name: 'spawn_agent', parameters: { properties: { task: { type: 'string' } } } } },
    { function: { name: 'read_file', parameters: { properties: { path: {}, offset: {}, limit: {} } } } }
  ];
  const salvage2 = (text) => salvageToolCalls(text, withArgs);

  r = salvage2('spawn_agent(task="src/tools.mjs を読み、always の道具を挙げてください。")');
  check('関数の形も拾う', r.calls.length === 1 && r.calls[0].name === 'spawn_agent'
    && r.calls[0].args.task.includes('always'), JSON.stringify(r));

  r = salvage2('では調べます。\nread_file(path="src/app.js", limit=50)');
  check('引数が複数でも拾う', r.calls.length === 1 && r.calls[0].args.path === 'src/app.js'
    && r.calls[0].args.limit === 50, JSON.stringify(r));

  r = salvage2('read_file({"path":"a.js"})');
  check('括弧の中がJSONでも拾う', r.calls.length === 1 && r.calls[0].args.path === 'a.js', JSON.stringify(r));

  // ここを間違えると、説明したつもりの一文が実行される
  r = salvage2('この処理は read_file(ファイルを読む道具) を使っています。');
  check('文の途中で触れただけなら拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('read_file(なにかいい感じに)');
  check('引数の名前が合わなければ拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('spawn_agent(depth=3)');
  check('持っていない引数名なら拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('unknown_tool(path="a.js")');
  check('知らない道具の関数形は拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('調べます。\nspawn_agent(task="どこで決めているか（判定の場所）を教えて")');
  check('引数の中の丸括弧で切らない', r.calls.length === 1
    && r.calls[0].args.task === 'どこで決めているか（判定の場所）を教えて', JSON.stringify(r));

  r = salvage2('やります。\nspawn_agent(task="調べて")');
  check('関数形も本文から取り除く', r.cleaned === 'やります。', JSON.stringify(r));

  // 書き方を説明しているだけの例を実行してしまわないこと
  r = salvage2('使い方はこうです。\n```js\nread_file(path="a.js")\n```\n以上です。');
  check('コード例の中は拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('文の途中に書かれた spawn_agent(task="やって") は拾いません。');
  check('行の途中から始まるものは拾わない', r.calls.length === 0, JSON.stringify(r));
}

console.log('\n宣言だけで手を動かさない返答の検知');
{
  // 「やります」と書いて終わるモデルがある。待っていても永遠に動かないので促す。
  // ただし、正しい完了報告まで促してしまっては逆効果になる。
  const yes = [
    'Let me locate the sum.js file and correct it.\n\nStep 1: Locate the file\nPlease proceed with the first step.',
    'I will search for the test file and read its content.',
    'これから sum.js を修正します。',
    '次に、テストを実行してください。',
    // 完了報告と次の宣言が同居する形。実機で促しが不発になった実例。
    'I have fixed the sum function. Now, I will run the tests again to verify the changes.',
    'sum.js を直しました。次に、テストを実行します。'
  ];
  const no = [
    'sum.js の引き算を足し算に直しました。npm test は通っています。',
    'I changed the implementation in sum.js and the tests now pass.',
    '合計は 57,000円です。',
    'I ran npm test and verified all tests passed.',
    // 実機で誤検知した形。ただのコードの説明が「します。」で終わっているだけ。
    // これを拾うと、正しく答えたあとに催促が出て「指示が不明確です」と聞き返す返事に化ける。
    'cart.js の total 関数は、買い物かごの合計金額を計算するものです。\n\n引数 items という配列を受け取り、各アイテムの価格と数量を掛け合わせて合計を求め、その合計金額を返します。',
    'この関数は配列を受け取り、条件に合う要素だけを残した新しい配列を返します。',
    'エラーが起きた場合は null を返します。'
  ];
  let ok = true;
  for (const t of yes) if (!describesIntentWithoutActing(t)) { ok = false; console.log(`       見逃し: ${t.slice(0, 40)}`); }
  for (const t of no) if (describesIntentWithoutActing(t)) { ok = false; console.log(`       誤検知: ${t.slice(0, 40)}`); }
  check(`宣言だけの返答${yes.length}件を検知し、完了報告${no.length}件は促さない`, ok);
}

// ── やっていないのに「やりました」と言う ────────────────────
//
// 実機で出た不具合。read_file だけ呼んで「4行目を修正しました」と報告し、
// ファイルは1文字も変わらないまま終わっていた。
// 上の判定は過去形をわざと除外しているので、こちらで拾う。
// この関数は「そう言っているか」だけを見る。本当かどうかは ctx.mutations と突き合わせる。
console.log('\nやっていないのに「やりました」と言う返答の検知');
{
  const claims = [
    '4 行目の i <= items.length を i < items.length に修正しました。',
    'sum.js を直しました。',
    'I fixed the off-by-one error in cart.js.',
    'I have updated the loop condition.',
    'The fix is applied to line 4.',
    'テストを追加しました。',
    '不要な行を削除しました。',
    'ファイルを作成しました。'
  ];
  const notClaims = [
    // 手を動かさなくても成り立つ、正しい報告
    'ファイルを確認しました。バグは 4 行目にあります。',
    'I read cart.js and the bug is on line 4.',
    '合計は 57,000円です。',
    // 打ち消している場合
    'まだ修正していません。先に確認させてください。',
    'I did not change the file because the path was outside the project.',
    '直す必要はありません。',
    // 完了報告と打ち消しが同居する形。前半は本物の主張なので拾えないと困る
  ];
  let ok = true;
  for (const t of claims) if (!claimsWorkDone(t)) { ok = false; console.log(`       見逃し: ${t.slice(0, 40)}`); }
  for (const t of notClaims) if (claimsWorkDone(t)) { ok = false; console.log(`       誤検知: ${t.slice(0, 40)}`); }
  check(`「やりました」${claims.length}件を検知し、そうでない${notClaims.length}件は拾わない`, ok);

  // 打ち消しは文ごとに見る。全文で見ると、前半の本物の完了報告まで消えてしまう。
  check(
    '打ち消しが別の文にあっても、完了報告は拾える',
    claimsWorkDone('cart.js を修正しました。テストは実行していません。')
  );
}

// ── 直した全文を画面に貼るだけで保存しない ──────────────────
//
// 実機で出た不具合。read_file のあと、関数を1つ足した全文を ``` で囲んで出して終わり、
// ファイルは元のままだった。本人は何も主張しないので、文章を読む判定では捕まらない。
console.log('\n書き直した中身を貼っただけの返事の検知');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwc-rewrite-'));
  const target = path.join(dir, 'cart.js');
  const source = [
    '// 買い物かごの合計を出す',
    'export function total(items) {',
    '  let sum = 0;',
    '  for (let i = 0; i < items.length; i++) {',
    '    sum += items[i].price * items[i].qty;',
    '  }',
    '  return sum;',
    '}'
  ].join('\n');
  fs.writeFileSync(target, source, 'utf8');
  const rctx = { root: dir, readFiles: new Set([target]) };

  // 実機で出た形そのまま。元の全文＋足した関数
  const rewrite = '```javascript\n' + source + '\n\n// 割引後の合計\nexport function totalWithDiscount(items, discount) {\n  return total(items) * (1 - discount);\n}\n```';
  check('元の全文を含む塊は「保存し忘れ」と分かる', looksLikeFileRewrite(rewrite, rctx) === target);

  // 説明のための短い引用は、重なりが少ないので拾わない
  const quote = '合計はここで足しています。\n\n```javascript\n    sum += items[i].price * items[i].qty;\n```\n\nこの1行が本体です。';
  check('説明のための数行の引用は拾わない', looksLikeFileRewrite(quote, rctx) === null);

  // まったく別のコードを見せる場合も拾わない
  const other = '```javascript\nconst x = fetch("https://example.com/very/long/path");\nconsole.log(await x.text());\nprocess.exit(0);\n```';
  check('関係のないコード例は拾わない', looksLikeFileRewrite(other, rctx) === null);

  // コードの塊が無ければ、そもそも対象外
  check('``` が無ければ拾わない', looksLikeFileRewrite('cart.js は合計を計算します。', rctx) === null);

  // 読んでいないファイルは比べようがない
  check('読んでいないファイルとは比べない', looksLikeFileRewrite(rewrite, { root: dir, readFiles: new Set() }) === null);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 直し方を述べただけで、自分では直さない ───────────────────
//
// コーディングを頼む道具なのに、毎回「直して」と言い直させることになる。
// 上の2つとは別物。あちらは「これからやります」と「やりました」。こちらは**やる気が無い**返事。
console.log('\n直し方を述べただけの返事の検知');
{
  const advice = [
    '税率が古いですね。0.08 を 0.1 に変更する必要があります。',
    'この行は i < items.length にすべきです。',
    'withTax の中身を修正してください。',
    'The rate should be updated to 0.1.',
    'You can change 1.08 to 1.1 to fix this.',
    'I recommend extracting the rate into a constant.'
  ];
  const notAdvice = [
    // 自分で直したうえで説明している
    '0.08 を 0.1 に変更しました。テストも通っています。',
    'I changed the rate to 0.1 and the tests pass.',
    // ただの説明
    'withTax は価格に税率をかけて返します。',
    '合計は 57,000円です。',
    // 直したうえで、次にやるべきことを利用者に伝えている
    'price.js を修正しました。呼び出し側も確認したほうがよいかもしれません。'
  ];
  let ok = true;
  for (const t of advice) if (!recommendsWithoutActing(t)) { ok = false; console.log(`       見逃し: ${t.slice(0, 40)}`); }
  for (const t of notAdvice) if (recommendsWithoutActing(t)) { ok = false; console.log(`       誤検知: ${t.slice(0, 40)}`); }
  check(`勧めただけ${advice.length}件を検知し、そうでない${notAdvice.length}件は拾わない`, ok);
}

// ── 促しが本当にループから出るか ────────────────────────────
//
// 判定の関数が正しいことと、それがループで使われていることは別。
// モデルの返事を台本で差し替えて、往復そのものを確かめる。
// 実機は温度0.3で毎回違う道を通るので、これを実機の確認の代わりにはできない。逆も同じ。
console.log('\nやったと言い張ったときの促し（ループの往復）');
{
  // 台本どおりに返すだけの偽モデル
  class ScriptedAgent extends Agent {
    constructor(opts, script) {
      super(opts);
      this.script = script;
      this.calls = 0;
    }
    async streamAssistant() {
      const step = this.script[this.calls++] || { content: '終わりです。' };
      if (step.mutate) this.ctx.mutations = (this.ctx.mutations || 0) + 1;
      return {
        message: { role: 'assistant', content: step.content },
        toolCalls: [],
        stats: null
      };
    }
  }

  const mkAgent = (script) =>
    new ScriptedAgent(
      {
        config: { ...baseConfig(), maxSteps: 6, isSubagent: true },
        root,
        permissions: new PermissionManager(baseConfig(), async () => 'n')
      },
      script
    );

  const nudgeText = /did not call write_file/;
  const nudgesIn = (agent) =>
    agent.messages.filter((m) => m.role === 'user' && nudgeText.test(m.content || '')).length;

  // 実機で出た形。読んだだけで「修正しました」と言って終わる。
  {
    const a = mkAgent([{ content: '4 行目の i <= items.length を i < items.length に修正しました。' }, { content: '直しました。' }]);
    await a.runTurn('cart.js のバグを直して');
    check('手を動かさずに「修正しました」と言ったら促す', nudgesIn(a) > 0);
  }

  // 本当に直したときは促さない。ここが壊れると、正しく終わるたびに催促が出る。
  {
    const a = mkAgent([{ content: 'cart.js を修正しました。', mutate: true }]);
    await a.runTurn('cart.js のバグを直して');
    check('本当に書き換えたあとの完了報告は促さない', nudgesIn(a) === 0);
  }

  // 手を動かしていなくても、変えたと言っていなければ促さない（ただの質問への答え）。
  {
    const a = mkAgent([{ content: 'バグは 4 行目にあります。境界の比較が誤っています。' }]);
    await a.runTurn('cart.js のどこが悪い？');
    check('変えたと言っていない答えは促さない', nudgesIn(a) === 0);
  }

  // 直し方を述べただけで終わったら、直させる
  {
    const a = mkAgent([{ content: '0.08 を 0.1 に変更する必要があります。' }, { content: 'はい。' }]);
    a.config.isSubagent = false;
    await a.runTurn('税率が古いから直して');
    const said = a.messages.filter((m) => m.role === 'user' && /did not make it/.test(m.content || ''));
    check('勧めただけで終わったら促す', said.length > 0);
  }

  // 独り言では促さない。
  //
  // ここは元は「税率が古いよ」で促す側に置いていた。頼まれてもいないのに
  // 「直せ」と押していたわけで、それが実機で勝手な書き換えになっていた。
  {
    const a = mkAgent([{ content: '0.08 を 0.1 に変更する必要がありますね。' }, { content: 'はい。' }]);
    a.config.isSubagent = false;
    await a.runTurn('税率が古いままだなあ');
    const said = a.messages.filter((m) => m.role === 'user' && /did not make it/.test(m.content || ''));
    check('独り言では促さない', said.length === 0);
  }

  // 雑談モードでも促さない（道具を渡していないので、押しても行き場がない）
  {
    const a = mkAgent([{ content: '0.08 を 0.1 に変更する必要があります。' }, { content: 'はい。' }]);
    a.config.isSubagent = false;
    a.config.chatMode = true;
    await a.runTurn('税率が古いから直して');
    const said = a.messages.filter((m) => m.role === 'user' && /did not make it/.test(m.content || ''));
    check('雑談モードでは促さない', said.length === 0);
  }

  // 計画モードでは促さない。書く道具そのものが外してあり、勧めて終わるのが正しい
  {
    const a = mkAgent([{ content: '0.08 を 0.1 に変更する必要があります。' }]);
    a.config.isSubagent = false;
    a.config.planMode = true;
    await a.runTurn('どう直すべき？');
    const said = a.messages.filter((m) => m.role === 'user' && /did not make it/.test(m.content || ''));
    check('計画モードでは促さない', said.length === 0);
  }

  // 調べもの係でも促さない。あちらは何も変更できない
  {
    const a = mkAgent([{ content: '0.08 を 0.1 に変更する必要があります。' }]);
    a.config.isSubagent = true;
    await a.runTurn('税率はどうなっている？');
    const said = a.messages.filter((m) => m.role === 'user' && /did not make it/.test(m.content || ''));
    check('調べもの係では促さない', said.length === 0);
  }

  // 空の返事で黙って終わらない。
  // 実機で、6分ぶん読み進めたあと空を返し、画面に1文字も出さずに終わっていた。
  // 利用者から見れば「アバウトに頼むと何も起きない」になる。
  {
    const a = mkAgent(Array.from({ length: 10 }, () => ({ content: '' })));
    a.config.isSubagent = false;
    a.config.maxNudges = 2;
    await a.runTurn('画面が見にくいから、いい感じにして');
    const pushed = a.messages.filter((m) => m.role === 'user' && /empty response/.test(m.content || ''));
    check('空の返事は、最初の1手でなくても促す', pushed.length === 2, `${pushed.length} 回`);
    check('促す回数は maxNudges で止まる', pushed.length <= 2);
  }

  // 調べてばかりで結論に進まないとき、1度だけ区切りを入れる
  {
    // 道具を呼び続けるだけの台本。実機で見た「読み続けて終わらない」形
    const a = mkAgent([]);
    a.config.isSubagent = false;
    a.config.exploreLimit = 4;
    a.config.maxSteps = 12;
    let calls = 0;
    a.streamAssistant = async () => {
      calls++;
      return {
        message: { role: 'assistant', content: '', tool_calls: [] },
        toolCalls: [{ id: `t${calls}`, function: { name: 'list_dir', arguments: {} } }],
        stats: null
      };
    };
    // 道具は数えるだけにする（実物を動かさない）
    a.executeTool = async () => {
      a.stats.toolCalls++;
      return { output: 'ok', denied: false };
    };
    await a.runTurn('画面が見にくいから、いい感じにして');
    const wrap = a.messages.filter((m) => m.role === 'user' && /Stop reading/.test(m.content || ''));
    check('調べるばかりで進まないとき、区切りを促す', wrap.length === 1, `${wrap.length} 回`);
    // 出口に「変更しろ」だけを置くと、質問しただけの人のファイルを触ってしまう
    check('答えるか、1つ聞く道も示す', /answer it/.test(wrap[0]?.content || '') && /ask ONE question/.test(wrap[0]?.content || ''));
  }

  // 促しても言い張り続ける相手に、無限に付き合わない
  {
    const script = Array.from({ length: 20 }, () => ({ content: '修正しました。' }));
    const a = mkAgent(script);
    a.config.maxNudges = 2;
    a.config.maxSteps = 20;
    await a.runTurn('cart.js のバグを直して');
    check('促す回数は maxNudges で頭打ちになる', nudgesIn(a) === 2, `実際: ${nudgesIn(a)} 回`);
  }
}

// ── 確認をどこまで飛ばすか ──────────────────────────────────
//
// 全部飛ばす（--yolo）と毎回聞かれるの間に、書き換えだけ飛ばす段階を置いてある。
console.log('\n確認を飛ばす段階');
{
  const mk = (over) => new PermissionManager({ ...baseConfig(), ...over }, async () => 'n');

  const strict = mk({});
  check('既定では、書き換えもコマンドも確認する', !strict.autoAllowed('edit_file') && !strict.autoAllowed('run_command'));

  const edits = mk({ acceptEdits: true });
  check('書き換えだけ飛ばす: write_file は通す', edits.autoAllowed('write_file'));
  check('書き換えだけ飛ばす: edit_file は通す', edits.autoAllowed('edit_file'));
  // ここが緩むと、戻せない操作が黙って走る
  check('書き換えだけ飛ばす: コマンドは通さない', !edits.autoAllowed('run_command'));
  check('書き換えだけ飛ばす: ネットは通さない', !edits.autoAllowed('web_fetch') && !edits.autoAllowed('web_search'));
  check('書き換えだけ飛ばす: ブラウザは通さない', !edits.autoAllowed('browse'));

  const all = mk({ autoApprove: true });
  check('全部飛ばす: どれも通す', all.autoAllowed('run_command') && all.autoAllowed('edit_file') && all.autoAllowed('browse'));

  // 実際に確認をとる経路でも同じ判断になっているか（判定だけ直して経路が古い、を防ぐ）
  const asked = [];
  const spy = new PermissionManager({ ...baseConfig(), acceptEdits: true }, async (q) => {
    asked.push(q);
    return 'n';
  });
  const okEdit = await spy.request({ toolName: 'edit_file', args: {}, title: '', preview: '' });
  check('書き換えでは人に聞かない', okEdit.granted && asked.length === 0);
  const okCmd = await spy.request({ toolName: 'run_command', args: { command: 'rm -rf x' }, title: '', preview: '' });
  check('コマンドでは人に聞く', !okCmd.granted && asked.length === 1);
}

console.log('\n差分表示');
{
  const d = renderDiff('a\nb\nc\n', 'a\nB\nc\n');
  check('変わった行だけを出す', /-b/.test(d) && /\+B/.test(d) && !/-a/.test(d), d);
  check('変化なしはその旨を出す', /変化はありません/.test(renderDiff('same\n', 'same\n')));

  // 書き換えた中身を画面に出すのは、道具側の印（showsDiff）で決める。
  // 印が付いていないと agent.mjs は何も出さないので、ここで固定しておく。
  const writes = ['write_file', 'edit_file'];
  const shows = TOOLS.filter((t) => t.showsDiff).map((t) => t.name).sort();
  check('書き換える道具には、中身を出す印が付いている', JSON.stringify(shows) === JSON.stringify(writes.sort()), shows.join(', '));

  // 読むだけの道具に付けてはいけない（読んだ中身を二重に流すことになる）
  check(
    '読むだけの道具には付いていない',
    !TOOL_MAP.get('read_file').showsDiff && !TOOL_MAP.get('list_dir').showsDiff && !TOOL_MAP.get('run_command').showsDiff
  );

  // 実行前に作る必要がある。実行後では元の中身が消えていて、差分を作れない
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwc-diff-'));
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'いち\nに\nさん\n', 'utf8');
    const dctx = { root: dir, config: baseConfig(), changedFiles: new Set(), readFiles: new Set(), signal: null };
    const before = TOOL_MAP.get('write_file').preview({ path: 'a.txt', content: 'いち\nZZ\nさん\n' }, dctx);
    check('実行前なら、消える行と増える行の両方が出る', /-に/.test(before) && /\+ZZ/.test(before), before);

    // 新規作成のときは、消える行が無いので中身をそのまま見せる
    const fresh = TOOL_MAP.get('write_file').preview({ path: 'b.txt', content: 'あ\nい\n' }, dctx);
    check('新規作成では、書く中身が出る', /\+あ/.test(fresh) && /\+い/.test(fresh), fresh);

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 確認が本当に出るか ──────────────────────────────────────
//
// 以前、6つの道具すべてが approval:'never' になっていて、
// README が謳う確認が一度も出ない状態だった。同じことを二度起こさないための番人。
console.log('\n実行前の確認');
{
  const expected = {
    read_file: 'never',
    list_dir: 'never',
    search_files: 'never',
    write_file: 'always',
    edit_file: 'always',
    run_command: 'conditional',
    web_search: 'always',
    web_fetch: 'always',
    browse: 'always',
    browser_login: 'always',
    todo_write: 'never',
    find_symbol: 'never',
    spawn_agent: 'never',
    read_skill: 'never'
  };
  let ok = true;
  for (const t of TOOLS) {
    const want = expected[t.name];
    if (t.approval !== want) {
      ok = false;
      console.log(`       ${t.name}: ${t.approval} になっている（${want} のはず）`);
    }
  }
  check('書き換え・コマンド・ネットは確認を通る設定になっている', ok);

  // 確認が要る道具は、何をするか見せる手段を必ず持っていること
  const guarded = TOOLS.filter((t) => t.approval !== 'never');
  check(
    `確認する${guarded.length}件すべてに見出しと下見がある`,
    guarded.every((t) => typeof t.approvalTitle === 'function' && typeof t.preview === 'function')
  );

  // conditional の道具は判定関数が要る（無いと素通りする）
  check(
    'conditional の道具には判定関数がある',
    TOOLS.filter((t) => t.approval === 'conditional').every((t) => typeof t.needsApproval === 'function')
  );
}

// ── ネットの道具の出し分け ──────────────────────────────────
console.log('\nネットの道具');
{
  const off = activeTools({ net: false }).map((t) => t.name);
  check('--no-net ではネットの道具を1つも渡さない', !off.includes('web_search') && !off.includes('web_fetch'));
  check('--no-net でも手元の道具は残る', off.includes('read_file') && off.includes('write_file'), off.join(', '));

  const on = activeTools({ net: true }).map((t) => t.name);
  check('ネット時は web_fetch を渡す', on.includes('web_fetch'));
}

// ── 意味で探す（LSP） ───────────────────────────────────────
console.log('\n意味で探す（LSP）');
{
  const off = activeTools({ net: false, lspReady: false }).map((t) => t.name);
  check('言語サーバーが無ければ渡さない', !off.includes('find_symbol'));

  const on = activeTools({ net: false, lspReady: true }).map((t) => t.name);
  check('あれば渡す', on.includes('find_symbol'));

  // 読むだけなので、計画モードでも使える
  const planning = activeTools({ net: false, lspReady: true, planMode: true }).map((t) => t.name);
  check('計画モードでも使える', planning.includes('find_symbol'));

  // コメントに書かれたコード例を定義と誤認しない（このリポジトリで実際に起きた）
  check('コメント行を定義とみなさない', looksLikeCommentForTest('  // export function foo() {'));
  check('本物の定義は通す', !looksLikeCommentForTest('export function foo() {'));
  check('ブロックコメントも除く', looksLikeCommentForTest('   * const bar = 1'));
}

// ── 調べものを任せる ────────────────────────────────────────
console.log('\n調べものを任せる');
{
  const normal = activeTools({ net: false }).map((t) => t.name);
  check('本体には渡す', normal.includes('spawn_agent'));

  // 入れ子は木が無限に広がるので、任された側には渡さない
  const sub = activeTools({ net: false, isSubagent: true }).map((t) => t.name);
  check('任された側には渡さない', !sub.includes('spawn_agent'));

  // 任された側は読むだけ。2つが同時に書いたら、どちらの結果も信用できなくなる
  const subTools = activeTools({ net: false, planMode: true, isSubagent: true }).map((t) => t.name);
  check('任された側は書き換えられない', !subTools.includes('write_file') && !subTools.includes('edit_file'));
  check('任された側も調べる道具は持つ', subTools.includes('read_file') && subTools.includes('search_files'));

  // 入れ子を頼まれたら、道具の側でも断る（渡していなくても、本文から拾われる場合がある）
  const spawn = TOOL_MAP.get('spawn_agent');
  const asSub = { ...ctx, config: { ...ctx.config, isSubagent: true } };
  const refused = await spawn.run({ task: 'なにか調べて' }, asSub);
  check('入れ子の依頼は道具が断る', refused.isError === true, refused.display);

  check('空の依頼を断る', (await spawn.run({ task: '  ' }, { ...ctx, config: { ...ctx.config } })).isError === true);

  // やることリストは人に見せるためのもの。任された側の画面は流れて消えるので渡さない
  check('任された側にやることリストは渡さない', !subTools.includes('todo_write'));
  check('計画モードだけならやることリストは渡す', activeTools({ net: false, planMode: true }).map((t) => t.name).includes('todo_write'));

  // 立場が違うので指示ごと入れ替える。
  // 計画モードの文面は「承認されたら自分が実装する」前提なので、任された側に渡ると嘘になる
  const subPrompt = buildSystemPrompt({ root, config: { ...ctx.config, planMode: true, isSubagent: true } });
  check('任された側は調べる係だと名乗る', subPrompt.includes('research assistant'));
  check('計画モードの説明文は渡さない', !subPrompt.includes('PLAN MODE'));
  check('変更したと言わせない', subPrompt.includes('Never claim you changed'));

  const planPrompt = buildSystemPrompt({ root, config: { ...ctx.config, planMode: true } });
  check('計画モードにはそのままの説明文', planPrompt.includes('PLAN MODE') && !planPrompt.includes('research assistant'));
}

// ── フォルダごとの決まりごと ────────────────────────────────
console.log('\nフォルダごとの決まりごと');
{
  put('rules/QWYTHOS.md', 'このフォルダは日本語で書くこと。');
  put('rules/deep/QWYTHOS.md', 'ここでは英語で書くこと。');
  put('rules/deep/target.js', 'const x = 1;\n');
  put('rules/plain.js', 'const y = 2;\n');

  const rulesCtx = { ...ctx, config: baseConfig(), deliveredRules: new Set() };

  let r = await read.run({ path: 'rules/deep/target.js' }, rulesCtx);
  check('近いフォルダの決まりごとを渡す', r.output.includes('ここでは英語で書くこと'), r.output.slice(-200));
  check('上のフォルダの決まりごとも渡す', r.output.includes('このフォルダは日本語で書くこと'));
  // 指示は末尾にあるものほど効くので、近いほうを後ろに置く
  check('近いほうを後ろに置く',
    r.output.lastIndexOf('ここでは英語') > r.output.lastIndexOf('このフォルダは日本語'));

  // 同じものを何度も積むと、それだけで文脈が埋まる
  r = await read.run({ path: 'rules/deep/target.js' }, rulesCtx);
  check('同じ決まりごとは二度渡さない', !r.output.includes('ここでは英語で書くこと'));

  // 作業フォルダ直下のものは最初から指示文に入っているので、ここでは渡さない
  put('QWYTHOS.md', 'いちばん上の決まりごと。');
  const freshCtx = { ...ctx, config: baseConfig(), deliveredRules: new Set() };
  r = await read.run({ path: 'rules/plain.js' }, freshCtx);
  check('いちばん上のものは二重に渡さない', !r.output.includes('いちばん上の決まりごと'));
  check('途中のフォルダのものは渡す', r.output.includes('このフォルダは日本語で書くこと'));
}

// ── 書き換えたあとに走らせる処理 ────────────────────────────
console.log('\n書き換えたあとに走らせる処理');
{
  const hookCtx = { ...ctx, config: baseConfig(), deliveredRules: new Set() };

  put('.qwythos/hooks.json', JSON.stringify({ afterEdit: 'echo 整えました $QWC_FILE_RELATIVE' }));
  let r = await write.run({ path: 'hooked.js', content: 'const a = 1;\n' }, hookCtx);
  check('書いたあとに走る', r.output.includes('afterEdit hook ok'), r.output);
  check('どのファイルかを渡す', r.output.includes('hooked.js'), r.output);

  // 失敗しても止めない。出力をそのままモデルに返して、直す機会を残す
  put('.qwythos/hooks.json', JSON.stringify({ afterEdit: 'echo かたちが違います >&2; exit 1' }));
  r = await write.run({ path: 'hooked2.js', content: 'const b = 1;\n' }, hookCtx);
  check('失敗しても書き込みは成功のまま', !r.isError, r.display);
  check('失敗の中身をモデルに返す', r.output.includes('かたちが違います'), r.output);
  check('直すよう促す', r.output.includes('Fix what it reported'), r.output);

  // 設定が無いプロジェクトでは何も起きない
  fs.rmSync(path.join(root, '.qwythos', 'hooks.json'));
  r = await write.run({ path: 'hooked3.js', content: 'const c = 1;\n' }, hookCtx);
  check('設定が無ければ何もしない', !r.output.includes('afterEdit'), r.output);

  put('.qwythos/hooks.json', '{壊れた');
  r = await write.run({ path: 'hooked4.js', content: 'const d = 1;\n' }, hookCtx);
  check('壊れた設定は黙って無視しない', r.output.includes('読めませんでした'), r.output);
  fs.rmSync(path.join(root, '.qwythos', 'hooks.json'));
}

// ── 手順書（スキル） ────────────────────────────────────────
console.log('\n手順書（スキル）');
{
  put('.qwythos/skills/release/SKILL.md',
    '---\nname: release\ndescription: リリース手順。版を上げてタグを打つまで\n---\n1. 版を上げる\n2. タグを打つ\n');
  put('.qwythos/skills/nometa/SKILL.md', 'ただの本文です。\n');

  const skills = loadSkills(root);
  check('見つけられる', skills.length === 2, JSON.stringify(skills.map((s) => s.name)));

  const release = skills.find((s) => s.name === 'release');
  check('頭の名前と説明を読む', release?.description.includes('リリース手順'), JSON.stringify(release));
  check('頭の部分は本文から外す', !release.body.includes('description:'), release?.body);
  check('名前が無ければフォルダ名を使う', skills.some((s) => s.name === 'nometa'));

  // 指示文に載せるのは名前と一行だけ。全文を載せると使わないぶんまで毎ターン払う
  const block = skillsBlock(skills);
  check('一覧には説明だけを載せる', block.includes('リリース手順') && !block.includes('1. 版を上げる'), block);

  const skill = TOOL_MAP.get('read_skill');
  let r = await skill.run({ name: 'release' }, ctx);
  check('読みにきたら全文を渡す', r.output.includes('タグを打つ'), r.output);

  // 名前を取り違えただけのことが多いので、実際にあるものを返す
  r = await skill.run({ name: 'releaes' }, ctx);
  check('名前違いには実際にあるものを教える', r.isError && r.output.includes('release'), r.output);

  // 1つも無いプロジェクトでは、読む道具そのものを渡さない
  const withSkills = activeTools({ net: false, skillCount: 2 }).map((t) => t.name);
  const without = activeTools({ net: false, skillCount: 0 }).map((t) => t.name);
  check('手順書があれば渡す', withSkills.includes('read_skill'));
  check('無ければ渡さない', !without.includes('read_skill'));

  fs.rmSync(path.join(root, '.qwythos', 'skills'), { recursive: true, force: true });
}

// ── 外の道具（MCP） ─────────────────────────────────────────
console.log('\n外の道具（MCP）');
{
  // 最小の MCP サーバーを立てて、本物の JSON-RPC でやりとりする。
  // 道具は3つ持たせ、設定では1つだけ使う（増やしすぎないことがいちばんの要点）。
  put('fake-mcp.mjs', `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'add', description: '2つの数を足す', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
    { name: 'noisy1', description: '使わない' },
    { name: 'noisy2', description: '使わない' }
  ] } });
  else if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params;
    if (name === 'add') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '答えは ' + (args.a + args.b) + ' です' }] } });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: '知らない道具' } });
  }
});
`);

  put('.qwythos/mcp.json', JSON.stringify({
    servers: { calc: { command: 'node', args: ['fake-mcp.mjs'], tools: ['add'] } }
  }));

  const { tools: mcp, notes } = await startMcp(root);
  check('つながって道具を持ってくる', mcp.length === 1, JSON.stringify(mcp.map((t) => t.name)));
  check('名前でどこの道具か分かる', mcp[0]?.name === 'mcp__calc__add', mcp[0]?.name);

  // 30個持っているサーバーの道具を全部見せると、9B は選べなくなる
  check('設定に書いた道具だけを渡す', !mcp.some((t) => t.name.includes('noisy')));

  // 何をする道具かはこちらには分からない。分からないものを黙って走らせない
  check('外の道具は必ず確認する', mcp[0]?.approval === 'always');

  let r = await mcp[0].run({ a: 3, b: 4 });
  check('実際に呼べて結果が返る', r.output.includes('答えは 7 です'), JSON.stringify(r));

  check('余計なお知らせは出さない', notes.length === 0, notes.join(' / '));

  // 設定で絞らなければ、上限まで自動で絞る
  put('.qwythos/mcp.json', JSON.stringify({
    servers: { calc2: { command: 'node', args: ['fake-mcp.mjs'] } }
  }));
  const loose = await startMcp(root);
  check('絞っていなければ全部渡すが上限は超えない', loose.tools.length === 3, String(loose.tools.length));

  // 名前を書き間違えたときに黙って減らさない
  put('.qwythos/mcp.json', JSON.stringify({
    servers: { calc3: { command: 'node', args: ['fake-mcp.mjs'], tools: ['addd'] } }
  }));
  const typo = await startMcp(root);
  check('無い道具を指定したら教える', typo.notes.some((n) => n.includes('addd')), typo.notes.join(' / '));

  // 立ち上がらないサーバーがあっても、理由を出して他は続ける
  put('.qwythos/mcp.json', JSON.stringify({
    servers: { broken: { command: 'this-command-does-not-exist-xyz' } }
  }));
  const broken = await startMcp(root);
  check('つながらなければ理由を出す', broken.notes.some((n) => n.includes('broken')), broken.notes.join(' / '));
  check('つながらなくても落ちない', Array.isArray(broken.tools) && broken.tools.length === 0);

  stopMcp();
  fs.rmSync(path.join(root, '.qwythos', 'mcp.json'));
}

// ── 別のアプリの中で動く ────────────────────────────────────
console.log('\n別のアプリの中で動く');
{
  // 道具の実体は相手が持つ。相手が持っている名前だけをモデルに見せる。
  const host = activeTools({ hostToolNames: ['read_file', 'list_dir'] }).map((t) => t.name);
  check('相手が持つ道具は渡す', host.includes('read_file') && host.includes('list_dir'));
  check('相手が持たない道具は渡さない', !host.includes('write_file') && !host.includes('run_command'));

  // やることリストと調べものの委譲は外に手を出さないので、相手の実装が要らない。
  // ここが持ち込める中身でもある（相手は輪と一緒にこの2つも手に入る）。
  check('外に触れない道具は付いていく', host.includes('todo_write') && host.includes('spawn_agent'));

  const sub = activeTools({ hostToolNames: ['read_file'], isSubagent: true }).map((t) => t.name);
  check('任された側には入れ子を渡さない', !sub.includes('spawn_agent'));
  check('任された側の扱いは本体のときと同じ', !sub.includes('todo_write'));
  check('任された側でも相手の道具は使える', sub.includes('read_file'));

  // ネットの鍵やブラウザの有無で勝手に増えない（増えたら相手が実装していない道具が混ざる）
  const withNet = activeTools({ hostToolNames: ['read_file'], net: true, browserReady: true }).map((t) => t.name);
  check('相手の一覧にないものは足さない', !withNet.includes('web_fetch') && !withNet.includes('browse'));
}

// ── ログイン済みブラウザ ────────────────────────────────────
console.log('\nブラウザ（ログインが要るページ用）');
{
  // Playwright が無い環境で browse を渡すと、呼ばれて失敗するだけで往復を1回損する
  const noPw = activeTools({ net: true, browserReady: false }).map((t) => t.name);
  check('Playwright が無ければ browse を渡さない', !noPw.includes('browse'));

  const withPw = activeTools({ net: true, browserReady: true }).map((t) => t.name);
  check('入っていれば browse を渡す', withPw.includes('browse'));
  check('--no-net なら入っていても渡さない', !activeTools({ net: false, browserReady: true }).map((t) => t.name).includes('browse'));

  // ログイン状態はホームの下に置く。作業フォルダには絶対に作らない
  check('ログイン状態はホームの下に置く', PROFILE_DIR.startsWith(os.homedir()), PROFILE_DIR);
  check('作業フォルダの中に作らない', !PROFILE_DIR.startsWith(root));

  check('サイト名だけでも https を補う', normalizeUrl('github.com') === 'https://github.com');
  check('http を書いてあれば尊重する', normalizeUrl('http://localhost:3000') === 'http://localhost:3000');
  check('file:// は受けない', normalizeUrl('file:///etc/passwd') === null);
  check('空は受けない', normalizeUrl('  ') === null);
}

// ── 取りに行ってよい URL か ─────────────────────────────────
console.log('\nURL の検査');
{
  const blocked = [
    'http://localhost:11434/api/tags',
    'http://127.0.0.1:8080/',
    'http://[::1]/',
    'http://192.168.1.1/',
    'http://10.0.0.5/admin',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',  // クラウドの資格情報が置いてある場所
    'http://printer.local/',
    'file:///etc/passwd',
    'ftp://example.com/x'
  ];
  let ok = true;
  for (const u of blocked) {
    if (checkUrl(u).ok) { ok = false; console.log(`       通してしまった: ${u}`); }
  }
  check(`手元・社内・別方式の${blocked.length}件を断る`, ok);

  const allowed = ['https://example.com/a?b=c', 'http://example.org/', 'https://docs.rs/serde/latest/serde/'];
  let ok2 = true;
  for (const u of allowed) {
    const r = checkUrl(u);
    if (!r.ok) { ok2 = false; console.log(`       断ってしまった: ${u} (${r.reason})`); }
  }
  check(`ふつうの${allowed.length}件は通す`, ok2);

  check('明示すれば手元も通せる', checkUrl('http://127.0.0.1:3000/', { allowLocal: true }).ok);
  check('空の URL を断る', !checkUrl('').ok);
  check('URLでない文字列を断る', !checkUrl('とりあえず調べて').ok);
}

// ── HTML を読める文にする ───────────────────────────────────
console.log('\nHTML の変換');
{
  const html = `<!doctype html><html><head><title>使い方 &amp; 注意</title>
    <style>.a{color:red}</style><script>var x=1;</script></head>
    <body><h1>見出し</h1><p>本文の1つ目です。</p><p>2つ目は&nbsp;空白入り。</p>
    <ul><li>ひとつ</li><li>ふたつ</li></ul>
    <div>末尾</div></body></html>`;
  const text = htmlToText(html);

  check('title を取り出す', extractTitle(html) === '使い方 & 注意', extractTitle(html));
  check('script の中身を捨てる', !text.includes('var x'), text.slice(0, 80));
  check('style の中身を捨てる', !text.includes('color:red'));
  check('タグが残らない', !/<[a-z/]/i.test(text), text.slice(0, 80));
  check('本文が残る', text.includes('本文の1つ目です。') && text.includes('末尾'));
  check('見出しに印が付く', text.includes('# 見出し'), text.slice(0, 40));
  check('箇条書きが行になる', text.includes('- ひとつ') && text.includes('- ふたつ'));
  check('空行が3つ以上続かない', !/\n{3,}/.test(text));

  check('数値参照を戻す', decodeEntities('&#72;&#x69;') === 'Hi');
  check('知らない実体はそのまま残す', decodeEntities('&unknownthing;') === '&unknownthing;');
  check('HTMLでない本文はそのまま扱える', htmlToText('ただの文章です') === 'ただの文章です');

  // 実体を戻すのはタグを落とし切った「あと」でなければならない。
  // 先に戻すと &lt;script&gt; が本物のタグに化けて、そのまま消えてしまう。
  // 実物のページで <v8::Local<T>> のような記法が出てきて気づいた性質。
  const escaped = htmlToText('<p>use &lt;v8::Local&lt;T&gt;&gt; here</p>');
  check('エスケープされた山かっこは本文として残る', escaped === 'use <v8::Local<T>> here', escaped);

  const fake = htmlToText('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  check('タグに化けさせずそのまま文字として出す', fake.includes('<script>alert(1)</script>'), fake);
}

// ── やることリスト ──────────────────────────────────────────
console.log('\nやることリスト');
{
  const todo = TOOL_MAP.get('todo_write');
  const tctx = { ...ctx, todos: [] };

  const r = await todo.run({
    todos: [
      { step: 'テストを走らせる', status: 'completed' },
      { step: '失敗を直す', status: 'in_progress' },
      { step: 'もう一度走らせる', status: 'pending' }
    ]
  }, tctx);
  check('リストを持ち回れる', tctx.todos.length === 3);
  check('進み具合を数える', /1\/3/.test(r.display), r.display);
  check('次にやることをモデルへ返す', /Next: 失敗を直す/.test(r.output), r.output.slice(0, 60));
  check('画面に出したので結果行は重ねない', r.quiet === true);

  // 手をつけているものが2つあると、どれを進めているのか分からなくなる
  await todo.run({
    todos: [
      { step: 'A', status: 'in_progress' },
      { step: 'B', status: 'in_progress' }
    ]
  }, tctx);
  check('in_progress は1つに絞る', tctx.todos.filter((t) => t.status === 'in_progress').length === 1);

  // 知らない状態を書かれても落ちない
  await todo.run({ todos: [{ step: 'C', status: 'こわれた値' }] }, tctx);
  check('知らない状態は pending に倒す', tctx.todos[0].status === 'pending');

  check('空のリストは断る', todo.validate({ todos: [] }) !== null);
  check('配列でなければ断る', todo.validate({ todos: 'あれこれ' }) !== null);
  check('多すぎるリストは断る', todo.validate({ todos: new Array(21).fill({ step: 'x', status: 'pending' }) }) !== null);
}

// ── 計画モード ──────────────────────────────────────────────
console.log('\n計画モード');
{
  const planning = activeTools({ net: false, planMode: true }).map((t) => t.name);
  check('書き換える道具を渡さない', !planning.includes('write_file') && !planning.includes('edit_file'));
  check('調べる道具は渡す', planning.includes('read_file') && planning.includes('search_files'));
  check('やることリストは使える', planning.includes('todo_write'));

  const normal = activeTools({ net: false, planMode: false }).map((t) => t.name);
  check('抜ければ書き換える道具が戻る', normal.includes('write_file') && normal.includes('edit_file'));

  // run_command は渡すが、中で状態を変えるものは断る
  const run = TOOL_MAP.get('run_command');
  const planCtx = { ...ctx, config: { ...ctx.config, planMode: true } };
  const danger = await run.run({ command: 'rm -rf /tmp/nope' }, planCtx);
  check('計画中は書き換えるコマンドを実行しない', danger.isError === true, danger.display);
  const safe = await run.run({ command: 'echo ok' }, planCtx);
  check('計画中でも読み取りのコマンドは通す', safe.isError === false, safe.display);
}

// ── 雑談モード ──────────────────────────────────────────────
console.log('\n雑談モード');
{
  const chatting = activeTools({ net: false, lspReady: true, chatMode: true }).map((t) => t.name);
  check('書き換える道具を渡さない', !chatting.includes('write_file') && !chatting.includes('edit_file'));
  check('調べる道具は残す', chatting.includes('read_file') && chatting.includes('search_files'));

  // ここから下は「作業のための道具」。雑談の相手に渡しても噛み合わない
  check('やることリストは渡さない', !chatting.includes('todo_write'));
  check('調べものの委譲は渡さない', !chatting.includes('spawn_agent'));
  check('記号をたどる道具は渡さない', !chatting.includes('find_symbol'));

  const back = activeTools({ net: false, lspReady: true, chatMode: false }).map((t) => t.name);
  check('抜ければ作業用の道具が戻る', back.includes('write_file') && back.includes('todo_write') && back.includes('spawn_agent'));

  // 話の途中で環境が変わらないよう、状態を変えるコマンドは断る
  const run = TOOL_MAP.get('run_command');
  const chatCtx = { ...ctx, config: { ...ctx.config, chatMode: true } };
  const danger = await run.run({ command: 'rm -rf /tmp/nope' }, chatCtx);
  check('雑談中は書き換えるコマンドを実行しない', danger.isError === true, danger.display);
  check('断る理由が雑談モードのものになる', /chat mode/.test(danger.output), danger.output);
  const safe = await run.run({ command: 'echo ok' }, chatCtx);
  check('雑談中でも読み取りのコマンドは通す', safe.isError === false, safe.display);

  // 人格そのものを入れ替える。「今は雑談です」を足すだけでは、
  // 「問題を指摘されたら直せ」という作業用の指示が残ってしまう
  const chatConfig = { ...ctx.config, chatMode: true };
  const chatPrompt = buildSystemPrompt({ root, config: chatConfig });
  check('コーディングエージェントだと名乗らない', !chatPrompt.includes('autonomous coding agent'));
  check('指摘を作業の指示として受け取らせない', !chatPrompt.includes('If they point out a problem'));
  check('雑談用の人格になっている', chatPrompt.includes('this is a conversation, not a coding job'));
  check('日本語の念押しは残す', chatPrompt.includes('返事も必ず日本語で書くこと'));
  check('戻り方を本人にも言えるようにする', chatPrompt.includes('/chat'));

  // 手順書を渡さない以上、読む道具も見せない（呼べない道具を見せない）
  check('手順書の数を 0 に下げる', chatConfig.skillCount === 0);
  check('手順書を読む道具は渡さない', !activeTools(chatConfig).map((t) => t.name).includes('read_skill'));

  // 作業用の足場は積まない。雑談に要らないうえ、その大半が「コードを直す係」の文脈になる
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwc-chat-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","scripts":{"build":"tsc"}}');
  fs.writeFileSync(path.join(dir, 'QWYTHOS.md'), '# 決まりごと\nここは秘密の合言葉テスト\n');
  const inProject = buildSystemPrompt({ root: dir, config: { ...ctx.config, chatMode: true } });
  check('プロジェクトの決まりごとを積まない', !inProject.includes('秘密の合言葉テスト'));
  check('プロジェクトの調査結果を積まない', !inProject.includes('npm scripts'));
  const working = buildSystemPrompt({ root: dir, config: { ...ctx.config, chatMode: false } });
  check('作業モードでは今までどおり積む', working.includes('秘密の合言葉テスト') && working.includes('npm scripts'));
  check('作業用のほうが指示文は長い', working.length > inProject.length, `${working.length} vs ${inProject.length}`);
  fs.rmSync(dir, { recursive: true, force: true });

  // 調べものを任された側は、雑談をしに来たのではない
  const subChat = buildSystemPrompt({ root, config: { ...ctx.config, chatMode: true, isSubagent: true } });
  check('任された側は雑談モードにならない', subChat.includes('research assistant'));

  check('/chat は組み込みコマンドとして予約されている', isReserved('chat'));
}

// ── 雑談か作業かの自動判定 ──────────────────────────────────
console.log('\n雑談か作業かの自動判定');
{
  // 依頼として受け取ってほしいもの。ここを取りこぼすと、毎回よけいな確認が出る
  const asWork = [
    'tax.js の税率を10%にして',
    'じゃあ tax.js の税率もそれに合わせて',
    '認証まわりをリファクタしたい',
    '--version フラグを足して',
    'テストを直して',
    'この関数のバグを修正',
    'ログイン機能の追加',
    'README を更新しといて',
    'src/app.js を読んで直して',
    'コミットして',
    'エラーが出るんだけど直せる？',
    'npm test 走らせて',
    'この関数、長いよね。短くして',
    'ここのインデント揃えてくれる？',
    'この変数名わかりやすくしてもらえる？',
    'console.log を全部消して',
    'ここ見てほしい',
    'これやって',
    '元に戻して',
    'fix the failing test',
    'add a --json flag'
  ];
  for (const t of asWork) {
    const r = classifyInput(t);
    check(`作業として受け取る: ${t}`, r.smallTalk === false, r.reason);
  }

  // 依頼ではないもの。ここを作業と取り違えると、頼んでいないのに書き換わる
  const asChat = [
    'こんにちは。今日はいい天気だね',
    'そういえば消費税っていま10%だよね',
    'コーヒーと紅茶ならどっち派？',
    'ありがとう、助かった',
    'この設計どう思う？',
    'なるほどね',
    'TypeScript ってなんで流行ったんだろう',
    'お疲れさま',
    '計画モードって便利だな',
    '最近ローカルLLM流行ってるよね',
    'tax.js ってどうなってる？',
    'この関数なにやってるの？',
    'ちなみにこれ知ってる？',
    // 伝聞の「って」を依頼のて形と取り違えない（実際に一度間違えた）
    'そうなんだって',
    '明日は休みだって',
    // どちらの形にもならない短い独り言は、安全な側に置く
    'うーん',
    '疲れた',
    'いい天気'
  ];
  for (const t of asChat) {
    const r = classifyInput(t);
    check(`雑談として受け取る: ${t}`, r.smallTalk === true, r.reason);
  }

  // 貼り付けたコードやエラーは、見てほしいから貼っている
  check('コードの貼り付けは作業', classifyInput('```js\nconst a = 1;\n```').smallTalk === false);
  check('長い貼り付けは作業', classifyInput('a\nb\nc\nd\ne\nf\ng').smallTalk === false);
  check('空の入力は作業側（判定しない）', classifyInput('').smallTalk === false);
  check('添える一言はファイルを変えるなと言う', /ファイルは変更しないこと/.test(SMALL_TALK_HINT));

  // 添える先が利用者の発言そのものなので、人に見せる文からは外す。
  // 外し忘れて、会話の一覧に判定の説明文が並んでいた（実機で発覚）。
  check('人に見せるときは添えた一言を外す',
    withoutHint('税率が古いなあ' + SMALL_TALK_HINT) === '税率が古いなあ');
  check('添えていない発言はそのまま', withoutHint('テストを直して') === 'テストを直して');
  check('空でも落ちない', withoutHint(undefined) === '');
  check('読む道具は使ってよいと言う', /read_file/.test(SMALL_TALK_HINT));

  // 判定を外したときの受け皿。書き換える道具に手が伸びたら聞く
  const agent = new Agent({
    config: { ...DEFAULT_CONFIG, autoApprove: true },
    root,
    permissions: new PermissionManager({ ...DEFAULT_CONFIG, autoApprove: true }, async () => 'n')
  });
  const writeTool = TOOL_MAP.get('write_file');
  const readTool = TOOL_MAP.get('read_file');
  const runTool = TOOL_MAP.get('run_command');
  check('書き換える道具は聞く対象', agent.touchesTheWorld(writeTool, {}) === true);
  check('読む道具は素通し', agent.touchesTheWorld(readTool, {}) === false);
  check('読み取りのコマンドは素通し', agent.touchesTheWorld(runTool, { command: 'ls' }) === false);
  check('状態を変えるコマンドは聞く対象', agent.touchesTheWorld(runTool, { command: 'rm -rf x' }) === true);

  // 別のアプリの中で動いているとき（--embed）は判定しない。
  // あちらには聞く相手がいないので、外したときに取り返す手が無い。
  class Silent extends Agent {
    async streamAssistant() {
      return { message: { role: 'assistant', content: 'はい' }, toolCalls: [], stats: null };
    }
  }
  const embedded = new Silent({ config: { ...DEFAULT_CONFIG }, root, permissions: null });
  await embedded.runTurn('いい天気だね');
  check('組み込みでは雑談判定をしない', embedded.ctx.smallTalk === false);
  check('組み込みでも道具の判定で落ちない', embedded.touchesTheWorld(runTool, { command: 'ls' }) === true);

  // ふつうの対話では、同じ発言がちゃんと雑談になる
  const local = new Silent({
    config: { ...DEFAULT_CONFIG },
    root,
    permissions: new PermissionManager({ ...DEFAULT_CONFIG }, async () => 'n')
  });
  await local.runTurn('いい天気だね');
  check('対話では雑談として受け取る', local.ctx.smallTalk === true);

  // 自分で /chat や /plan に入っているときは、人の決めたほうを優先する
  const chatAgent = new Agent({
    config: { ...DEFAULT_CONFIG, chatMode: true },
    root,
    permissions: new PermissionManager({ ...DEFAULT_CONFIG }, async () => 'n')
  });
  check('雑談モードでは判定そのものをしない', chatAgent.config.chatMode === true);
}

// ── @ でファイルを添える ────────────────────────────────────
console.log('\n@ でファイルを添える');
{
  fs.writeFileSync(path.join(root, 'notes.md'), '# メモ\n本文です\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const x = 1;\n');

  check('拾える', findMentions('@notes.md を読んで').join() === 'notes.md');
  check('日本語のすぐ後ろでも拾える', findMentions('この @src/app.js の中身').join() === 'src/app.js');
  check('文末の句点を名前に含めない', findMentions('@notes.md。').join() === 'notes.md');
  check('同じものは1回だけ', findMentions('@notes.md と @notes.md').length === 1);
  check('メールアドレスは拾わない', findMentions('foo@example.com に送って').length === 0);
  check('@ が無ければ空', findMentions('ふつうの文です').length === 0);

  const ok = resolveMentions('@notes.md と @src/app.js を見て', root);
  check('中身を読める', ok.attachments.length === 2, JSON.stringify(ok.missing));
  check('相対パスで持つ', ok.attachments.map((a) => a.name).sort().join() === 'notes.md,src/app.js');

  const block = buildMentionBlock(ok.attachments);
  check('渡す形に中身が入る', block.includes('本文です') && block.includes('const x = 1;'));

  // 作業フォルダの外を読ませない
  const escaped = resolveMentions('@../../.ssh/id_rsa を見て', root);
  check('作業フォルダの外は断る', escaped.attachments.length === 0 && escaped.missing.length === 1, JSON.stringify(escaped.missing));
  check('断った理由を返す', /外/.test(escaped.missing[0].reason));

  const gone = resolveMentions('@nowhere.txt', root);
  check('無いファイルは理由つきで返す', gone.missing.length === 1 && /見つかり/.test(gone.missing[0].reason));

  const dir = resolveMentions('@src', root);
  check('フォルダは断る', dir.missing.length === 1 && /フォルダ/.test(dir.missing[0].reason));
}

// ── 画像を見せる ────────────────────────────────────────────
console.log('\n画像を見せる');
{
  // 1x1 の PNG（実物のバイト列）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(path.join(root, 'shot.png'), png);

  check('拡張子で画像と分かる', isImagePath('a/b/shot.PNG') && isImagePath('x.webp'));
  check('コードは画像ではない', !isImagePath('src/app.js'));

  // 目のないモデルに送っても意味がないので、渡さず理由を返す
  const noEye = resolveMentions('@shot.png これ見て', root, { vision: false });
  check('目のないモデルには渡さない', noEye.images.length === 0 && noEye.missing.length === 1);
  check('別のモデルを案内する', /gemma4|画像を見られません/.test(noEye.missing[0].reason), noEye.missing[0].reason);

  const withEye = resolveMentions('@shot.png これ見て', root, { vision: true });
  check('目があれば画像として渡す', withEye.images.length === 1, JSON.stringify(withEye.missing));
  check('base64 で持つ', withEye.images[0].data === png.toString('base64'));
  check('文字の添付には混ぜない', withEye.attachments.length === 0);

  // 会話の保存に base64 を残さない（1枚で数MBになるため）
  const saved = JSON.parse(
    JSON.stringify({ messages: [{ role: 'user', content: 'x', images: ['AAAA', 'BBBB'] }] })
  );
  const stripped = stripImages(saved);
  check('保存時に画像の中身を落とす', !JSON.stringify(stripped).includes('AAAA'));
  check('見せた事実は残す', stripped.messages[0].imageCount === 2);
}

// ── 自分で作るコマンド ──────────────────────────────────────
console.log('\n自分で作るコマンド');
{
  const cmdDir = path.join(root, '.qwythos', 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.writeFileSync(path.join(cmdDir, 'review.md'), '# 変更を見直す\n直近の変更を確認して。\n$ARGUMENTS\n');
  fs.writeFileSync(path.join(cmdDir, 'plain.md'), '決まった手順をやって。\n');
  fs.writeFileSync(path.join(cmdDir, 'notes.txt'), '拾わない\n');

  const found = loadCommands(root);
  check('md だけを拾う', found.has('review') && found.has('plain') && !found.has('notes'));
  check('見出しを説明に使う', found.get('review').description === '変更を見直す');
  check('見出しは本文から外す', !found.get('review').body.includes('#'));

  check(
    '$ARGUMENTS に引数を入れる',
    renderCommand(found.get('review'), '認証まわり').includes('認証まわり')
  );
  check(
    '$ARGUMENTS が無ければ末尾に足す',
    renderCommand(found.get('plain'), '追加の指示').endsWith('追加の指示')
  );
  check('引数なしならそのまま', renderCommand(found.get('plain'), '') === '決まった手順をやって。');

  check('組み込みと同じ名前は分かる', isReserved('plan') && isReserved('todo') && !isReserved('review'));
}

// ── 入っているモデルから選ぶ ────────────────────────────────
console.log('\nモデルの自動選択');
{
  check('gemma4 を最優先する', pickBestModel(['qwen3:32b-q4_K_M', 'qwythos:latest', 'gemma4:26b']) === 'gemma4:26b');
  check('gemma4 が無ければ 9B', pickBestModel(['qwen3:32b-q4_K_M', 'qwythos:latest']) === 'qwythos:latest');
  check('埋め込み専用は選ばない', pickBestModel(['qwen3-embedding:0.6b', 'qwen3:14b-q4_K_M']) === 'qwen3:14b-q4_K_M');
  check('埋め込みしか無ければ選ばない', pickBestModel(['qwen3-embedding:0.6b']) === null);
  check('1つも無ければ null', pickBestModel([]) === null);
  check('知らない名前でも1つは返す', pickBestModel(['mystery:7b']) === 'mystery:7b');
}

// ── 使ううちに覚えたこと（継続ハーネス） ─────────────────────
//
// 考え方は prime-agent（MIT）から借りた。借りたのは
// 「基礎の指示文は書き換えない／小さく直す／根拠を持たせる／戻せるようにする」の4つ。
console.log('\n覚えたことの置き場');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwc-harness-'));

  check('何も無ければ、指示文に1文字も足さない', harnessBlock(loadHarness(dir)) === '');

  applyHarnessEdits(dir, [
    { op: 'create', scope: 'project', text: 'テストは npm test で走る', evidence: '実際に走らせて確認' }
  ]);
  const one = loadHarness(dir);
  check('作業フォルダ側に覚えられる', one.project.length === 1 && one.global.length === 0);
  check('根拠も一緒に残る', one.project[0].evidence === '実際に走らせて確認');

  const block = harnessBlock(one);
  check('指示文に載る', block.includes('テストは npm test で走る'));
  check('決めつけではなく手がかりとして渡す', block.includes('hints, not rules'));

  // 同じことを二度覚えない（毎ターンの固定費が二重になる）
  applyHarnessEdits(dir, [{ op: 'create', scope: 'project', text: 'テストは npm test で走る' }]);
  check('同じ内容は重ねて覚えない', loadHarness(dir).project.length === 1);

  // 長すぎる note は読み飛ばされるので切り詰める
  applyHarnessEdits(dir, [{ op: 'create', scope: 'project', text: 'あ'.repeat(500) }]);
  const long = loadHarness(dir).project.find((n) => n.text.startsWith('あ'));
  check('長すぎる覚え書きは切り詰める', long.text.length <= MAX_NOTE_CHARS, `${long.text.length} 文字`);

  // 直す・消す
  const id = loadHarness(dir).project[0].id;
  applyHarnessEdits(dir, [{ op: 'update', scope: 'project', id, text: 'テストは npm test（217件）' }]);
  check('覚えたことを直せる', loadHarness(dir).project[0].text === 'テストは npm test（217件）');
  applyHarnessEdits(dir, [{ op: 'delete', scope: 'project', id }]);
  check('覚えたことを消せる', !loadHarness(dir).project.some((n) => n.id === id));

  // 取り消し。当てる前の控えから丸ごと戻す
  undoHarness(dir);
  check('直前の変更を取り消せる', loadHarness(dir).project.some((n) => n.id === id));

  // 上限。覚えたことは毎ターンの入力に必ず乗るので、際限なく増やさない
  const many = Array.from({ length: MAX_NOTES + 8 }, (_, i) => ({
    op: 'create',
    scope: 'project',
    text: `覚え書き ${i}`
  }));
  applyHarnessEdits(dir, many);
  check('件数の上限を超えない', loadHarness(dir).project.length <= MAX_NOTES, `${loadHarness(dir).project.length} 件`);

  // 分からない指示は黙って捨てる。覚え書きのために作業を止めない
  applyHarnessEdits(dir, [{ op: 'なにこれ', scope: 'project', text: 'x' }, null, { op: 'create' }]);
  check('読めない指示では壊れない', loadHarness(dir).project.length <= MAX_NOTES);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n見直しの返事の読み取り');
{
  check(
    '素のJSONを読める',
    parseEdits('{"edits":[{"op":"create","scope":"project","text":"あ"}]}').length === 1
  );
  check(
    'フェンスで囲まれていても読める',
    parseEdits('わかりました。\n```json\n{"edits":[{"op":"create","scope":"global","text":"あ"}]}\n```').length === 1
  );
  check(
    '前置きが付いていても読める',
    parseEdits('以下のとおりです: {"edits":[{"op":"create","scope":"project","text":"あ"}]} 以上です。').length === 1
  );
  check('空の返事は「覚えることなし」として読める', parseEdits('{"edits":[]}').length === 0);
  check('JSONでなければ読めなかったと分かる', parseEdits('特にありません。') === null);
  check(
    '置き場の指定が無ければ、このフォルダ扱いにする',
    parseEdits('{"edits":[{"op":"create","text":"あ"}]}')[0].scope === 'project'
  );
  check(
    '知らない操作は捨てる',
    parseEdits('{"edits":[{"op":"drop","text":"あ"},{"op":"create","text":"い"}]}').length === 1
  );

  // 実機で出た壊れ方。中の文にコマンドを引用符ごと書いてしまい、JSON 全体が読めなくなる。
  // ここで諦めると、良い覚え書きまで丸ごと捨てることになる。
  {
    const broken =
      '```json\n{"edits":[{"op":"create","scope":"project",' +
      '"text":"node test_cart.js でテストを実行できる。",' +
      '"evidence":"run_command({"command":"node test_cart.js"}) を実行して成功したため。"}]}\n```';
    const got = parseEdits(broken);
    check('引用符で壊れた返事からでも拾い直せる', got && got.length === 1, JSON.stringify(got));
    check(
      '肝心の本文は欠けずに取れる',
      got?.[0]?.text === 'node test_cart.js でテストを実行できる。',
      got?.[0]?.text,
    );
    check('置き場も取れる', got?.[0]?.scope === 'project');
  }

  // 拾い直しは最後の手段。**まともな JSON なら、そちらを優先して使う**
  {
    const good = parseEdits('{"edits":[{"op":"create","scope":"global","text":"あ","evidence":"い"}]}');
    check('読める JSON はそのまま使う', good[0].evidence === 'い');
  }

  // 何も無い返事から、無理に拾わない
  check('覚えることが無い返事から捏造しない', parseEdits('{"edits":[]}').length === 0);
  check('関係のない文からは拾わない', parseEdits('特にありません。') === null);
}

// ── GPU に載りきったかを見る ────────────────────────────────
//
// 載りきらないと、はみ出した分が CPU 側で動いて極端に遅くなる。
// 画面には何も出ないので「今日はなぜか遅い」で終わってしまう。それを検知して軽いほうへ落とす。
console.log('\nGPU に載りきったかの判定');
{
  const http = await import('node:http');

  // Ollama のふりをして、載り具合だけ差し替えられるサーバー
  const fake = (ps) =>
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // /api/generate は読み込み、/api/ps は状況
      res.end(JSON.stringify(req.url === '/api/ps' ? ps : { done: true }));
    });

  const withServer = async (ps, fn) => {
    const srv = fake(ps);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      return await fn({ host: `http://127.0.0.1:${srv.address().port}`, model: 'big:26b', keepAlive: '30m' });
    } finally {
      srv.close();
    }
  };

  // 丸ごと GPU に載った
  const full = await withServer({ models: [{ name: 'big:26b', size: 17_300_000_000, size_vram: 17_300_000_000 }] }, checkGpuFit);
  check('全部 GPU に載っていれば、そのまま使う', full.ok === true && full.onGpu === 1);

  // 半分しか載らなかった＝はみ出しがCPU側にある
  const half = await withServer({ models: [{ name: 'big:26b', size: 17_300_000_000, size_vram: 8_000_000_000 }] }, checkGpuFit);
  check('半分しか載らなければ、載りきらないと判定する', half.ok === false, `GPU率 ${Math.round(half.onGpu * 100)}%`);

  // わずかなはみ出しは実害が無いので通す（数値の端数で毎回警告を出さない）
  const almost = await withServer({ models: [{ name: 'big:26b', size: 100, size_vram: 98 }] }, checkGpuFit);
  check('わずかな端数では騒がない', almost.ok === true && GPU_FIT_THRESHOLD <= 0.98);

  // Ollama は :latest を付けたり外したりして返すことがある
  const bare = await withServer({ models: [{ name: 'big:26b:latest', size: 100, size_vram: 10 }] }, checkGpuFit);
  check(':latest の有無が違っても同じモデルと分かる', bare.ok === false);

  // 自分のモデルが一覧に無い＝判断材料が無い。取り上げずに通す
  const missing = await withServer({ models: [{ name: 'other:7b', size: 100, size_vram: 10 }] }, checkGpuFit);
  check('自分のモデルが見当たらなければ通す', missing.ok === true && missing.unknown === true);

  // つながらないときも、確かめられないことを理由に使えるものを取り上げない
  const down = await checkGpuFit({ host: 'http://127.0.0.1:1', model: 'big:26b', keepAlive: '30m' });
  check('Ollama に聞けなくても止めない', down.ok === true && down.unknown === true);
}

// ── 返事を待つ時間 ──────────────────────────────────────────
//
// Node の fetch は、1文字目が返るまで300秒で必ず諦める（undici の headersTimeout）。
// 手元のモデルは文脈が長いとそれ以上かかるので、少し長い作業をすると必ず落ちていた。
// 偽のサーバーを立てて、待ち方が自分の手の内にあることを確かめる。
console.log('\n返事を待つ時間');
{
  const http = await import('node:http');

  // 受け取るだけで何も返さないサーバー＝黙り込んだモデル
  const silent = http.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const silentPort = silent.address().port;

  let waited = 0;
  let message = '';
  const t0 = Date.now();
  try {
    const stream = chatStream({
      cfg: { host: `http://127.0.0.1:${silentPort}`, model: 'x', firstTokenMs: 300, stallMs: 300 },
      messages: [{ role: 'user', content: 'hi' }]
    });
    for await (const _ of stream) { /* 来ない */ }
  } catch (err) {
    waited = Date.now() - t0;
    message = err.message;
  }
  silent.close();

  check('黙ったままなら自分で見切る', waited > 0 && waited < 5000, `${waited}ms`);
  check('300秒の壁ではなく設定した長さで切れる', waited < 3000, `${waited}ms`);
  check('理由と次の手を日本語で言う', message.includes('だまったまま') && message.includes('/clear'), message);

  // 普通に返すサーバー＝ちゃんと最後まで読めること
  const talker = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'こん' } }) + '\n');
    res.write(JSON.stringify({ message: { content: 'にちは' } }) + '\n');
    res.end(JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 3 }) + '\n');
  });
  await new Promise((r) => talker.listen(0, '127.0.0.1', r));
  const talkPort = talker.address().port;

  let text = '';
  let done = null;
  for await (const ev of chatStream({
    cfg: { host: `http://127.0.0.1:${talkPort}`, model: 'x' },
    messages: [{ role: 'user', content: 'hi' }]
  })) {
    if (ev.type === 'content') text += ev.text;
    if (ev.type === 'done') done = ev;
  }
  talker.close();

  check('逐次で届く本文をつなげる', text === 'こんにちは', text);
  check('締めくくりの数字も拾う', done?.stats?.promptTokens === 12 && done?.stats?.outputTokens === 3);

  // 話しはじめてから黙り込んだ場合。ここは短い方の物差しで切る
  const halfway = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'とちゅう' } }) + '\n');
    // 以降は何も書かないまま放置する
  });
  await new Promise((r) => halfway.listen(0, '127.0.0.1', r));
  const halfPort = halfway.address().port;

  let partial = '';
  let stallMsg = '';
  const t1 = Date.now();
  try {
    for await (const ev of chatStream({
      cfg: { host: `http://127.0.0.1:${halfPort}`, model: 'x', firstTokenMs: 5000, stallMs: 300 },
      messages: [{ role: 'user', content: 'hi' }]
    })) {
      if (ev.type === 'content') partial += ev.text;
    }
  } catch (err) {
    stallMsg = err.message;
  }
  const stallWait = Date.now() - t1;
  halfway.close();

  check('途中で止まったら短い方で見切る', stallMsg.includes('とぎれた'), stallMsg);
  check('見切るまで待ちすぎない', stallWait < 3000, `${stallWait}ms`);
  check('そこまでに届いた分は受け取れている', partial === 'とちゅう', partial);

  // ここが 2026-08-28 に踏んだところ。
  // **Ollama は道具の呼び出しを、書き終えるまで送ってこない。**
  // 組み立てているあいだ1バイトも届かないので、見切りが短いと
  // 動いている作業のほうを殺す。実測で、正常に終わったやり取りが
  // Ollama 側では 1m22s〜4m46s かかっていた（3分の見切りでは届かない）。
  const buffering = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { content: '考えます' } })}\n`);
    // 道具の引数を組み立てているあいだの無音
    setTimeout(() => {
      res.write(
        `${JSON.stringify({
          message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.js' } } }] }
        })}\n`
      );
      res.end(`${JSON.stringify({ done: true })}\n`);
    }, 500);
  });
  await new Promise((r) => buffering.listen(0, '127.0.0.1', r));
  const bufPort = buffering.address().port;

  let toolName = null;
  try {
    for await (const ev of chatStream({
      cfg: { host: `http://127.0.0.1:${bufPort}`, model: 'x', firstTokenMs: 5000, stallMs: 2000 },
      messages: [{ role: 'user', content: 'hi' }]
    })) {
      if (ev.type === 'done') toolName = ev.toolCalls?.[0]?.name ?? null;
    }
  } catch (err) {
    toolName = `打ち切られた: ${err.message}`;
  }
  buffering.close();
  check('無音が見切りより短ければ、待って受け取る', toolName === 'read_file', String(toolName));
  check('既定の見切りは10分', DEFAULT_CONFIG.stallMs === 10 * 60 * 1000, String(DEFAULT_CONFIG.stallMs));

  // エラーはエラーとして見せる（黙って握りつぶさない）
  const angry = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('model not found');
  });
  await new Promise((r) => angry.listen(0, '127.0.0.1', r));
  const angryPort = angry.address().port;
  let httpErr = '';
  try {
    for await (const _ of chatStream({
      cfg: { host: `http://127.0.0.1:${angryPort}`, model: 'x' },
      messages: [{ role: 'user', content: 'hi' }]
    })) { /* 来ない */ }
  } catch (err) {
    httpErr = err.message;
  }
  angry.close();
  check('サーバーの言い分をそのまま見せる', httpErr.includes('500') && httpErr.includes('model not found'), httpErr);
}


console.log('\n/undo — 書き換えを戻す');
{
  const uroot = path.join(root, 'undo');
  fs.mkdirSync(uroot, { recursive: true });
  const fresh = () => ({
    root: uroot,
    config: ctx.config,
    changedFiles: new Set(),
    readFiles: new Set(),
    editFailures: new Map(),
    signal: null
  });
  const at = (name) => path.join(uroot, name);

  // 新しく作ったファイルは、戻すと消える
  {
    const u = fresh();
    beginTurn(u);
    await write.run({ path: 'new.js', content: 'const a = 1;\n' }, u);
    const made = fs.existsSync(at('new.js'));
    const r = undoLastTurn(u);
    check(
      '新しく作ったファイルは、戻すと消える',
      made && !fs.existsSync(at('new.js')) && r.restored[0]?.removed === true,
      JSON.stringify(r)
    );
    check('戻したファイルは「書き換えたファイル」からも外れる', u.changedFiles.size === 0, [...u.changedFiles].join(','));
  }

  // 上書きは、前の中身に返る
  {
    const u = fresh();
    fs.writeFileSync(at('keep.js'), 'もとの中身\n', 'utf8');
    beginTurn(u);
    await write.run({ path: 'keep.js', content: 'あたらしい中身\n' }, u);
    undoLastTurn(u);
    check('上書きしたファイルは、前の中身に返る', fs.readFileSync(at('keep.js'), 'utf8') === 'もとの中身\n');
  }

  // 1回のお願いで直した複数ファイルは、まとめて戻る
  {
    const u = fresh();
    fs.writeFileSync(at('x.js'), 'x1\n', 'utf8');
    fs.writeFileSync(at('y.js'), 'y1\n', 'utf8');
    beginTurn(u);
    await edit.run({ path: 'x.js', old_string: 'x1', new_string: 'x2' }, u);
    await edit.run({ path: 'y.js', old_string: 'y1', new_string: 'y2' }, u);
    const r = undoLastTurn(u);
    check(
      '1回のお願いで直した複数ファイルは、まとめて戻る',
      r.restored.length === 2 &&
        fs.readFileSync(at('x.js'), 'utf8') === 'x1\n' &&
        fs.readFileSync(at('y.js'), 'utf8') === 'y1\n',
      JSON.stringify(r)
    );
  }

  // 同じファイルを2回直しても、最初の姿まで返る（後ろから戻すため）
  {
    const u = fresh();
    fs.writeFileSync(at('twice.js'), 'A\n', 'utf8');
    beginTurn(u);
    await edit.run({ path: 'twice.js', old_string: 'A', new_string: 'B' }, u);
    await edit.run({ path: 'twice.js', old_string: 'B', new_string: 'C' }, u);
    undoLastTurn(u);
    check('同じファイルを2度直しても、最初の姿まで返る', fs.readFileSync(at('twice.js'), 'utf8') === 'A\n', fs.readFileSync(at('twice.js'), 'utf8'));
  }

  // お願いが違えば、1回ずつ戻る
  {
    const u = fresh();
    fs.writeFileSync(at('step.js'), '0\n', 'utf8');
    beginTurn(u);
    await edit.run({ path: 'step.js', old_string: '0', new_string: '1' }, u);
    beginTurn(u);
    await edit.run({ path: 'step.js', old_string: '1', new_string: '2' }, u);
    undoLastTurn(u);
    const mid = fs.readFileSync(at('step.js'), 'utf8');
    undoLastTurn(u);
    const first = fs.readFileSync(at('step.js'), 'utf8');
    check('お願いが違えば、1回の /undo で1つぶんだけ戻る', mid === '1\n' && first === '0\n', `${mid}/${first}`);
    check('戻しきったら、もう戻すものはない', canUndo(u) === false);
  }

  // そのあと人が触ったファイルには手を出さない
  {
    const u = fresh();
    fs.writeFileSync(at('mine.js'), 'もと\n', 'utf8');
    beginTurn(u);
    await write.run({ path: 'mine.js', content: 'モデルが書いた\n' }, u);
    fs.writeFileSync(at('mine.js'), '本人があとから直した\n', 'utf8');
    const r = undoLastTurn(u);
    check(
      'そのあと本人が触ったファイルは、戻さずに理由を返す',
      fs.readFileSync(at('mine.js'), 'utf8') === '本人があとから直した\n' &&
        r.restored.length === 0 &&
        /別に書き換え/.test(r.skipped[0]?.reason || ''),
      JSON.stringify(r)
    );
  }

  // 同じファイルを何度直しても、報告は1行にまとまる
  {
    const u = fresh();
    fs.writeFileSync(at('many.js'), '1\n', 'utf8');
    beginTurn(u);
    await edit.run({ path: 'many.js', old_string: '1', new_string: '2' }, u);
    await edit.run({ path: 'many.js', old_string: '2', new_string: '3' }, u);
    await edit.run({ path: 'many.js', old_string: '3', new_string: '4' }, u);
    const r = undoLastTurn(u);
    check(
      '同じファイルを3回直しても、報告は1行',
      r.restored.length === 1 && fs.readFileSync(at('many.js'), 'utf8') === '1\n',
      JSON.stringify(r)
    );
  }

  // 作ったあとに消されたファイルは、消えたと言う
  {
    const u = fresh();
    beginTurn(u);
    await write.run({ path: 'temp.js', content: 'x\n' }, u);
    await edit.run({ path: 'temp.js', old_string: 'x', new_string: 'y' }, u);
    fs.rmSync(at('temp.js'));
    const r = undoLastTurn(u);
    check(
      'もう無いファイルは「消されています」と言う（1行だけ）',
      r.skipped.length === 1 && /消されています/.test(r.skipped[0].reason),
      JSON.stringify(r)
    );
  }

  // 読めない形式は控えず、消しにいかない
  {
    const u = fresh();
    fs.writeFileSync(at('bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
    beginTurn(u);
    await write.run({ path: 'bin.dat', content: 'テキストで上書き\n' }, u);
    const r = undoLastTurn(u);
    check(
      '読めない形式のファイルは、戻せないと伝えて手を出さない',
      fs.existsSync(at('bin.dat')) && r.restored.length === 0 && r.skipped.length === 1,
      JSON.stringify(r)
    );
  }

  // 控えの中身を取り違えない（あったのに読めない → 消さない）
  {
    const u = fresh();
    beginTurn(u);
    recordEdit(u, { path: at('unreadable.js'), before: null, after: 'x', existed: true });
    const e = u.editLog[0];
    check('あったのに読めなかったものを「無かった」と丸めない', e.existed === true && e.big === true, JSON.stringify(e));
  }

  // /clear で控えも消える
  {
    const u = fresh();
    beginTurn(u);
    await write.run({ path: 'gone.js', content: '1\n' }, u);
    resetEdits(u);
    check('/clear のあとは戻すものが残らない', canUndo(u) === false);
  }
}

console.log('\n/diff — このセッションの通しの差分');
{
  const droot = path.join(root, 'diffsess');
  fs.mkdirSync(droot, { recursive: true });
  const d = {
    root: droot,
    config: ctx.config,
    changedFiles: new Set(),
    readFiles: new Set(),
    editFailures: new Map(),
    signal: null
  };
  fs.writeFileSync(path.join(droot, 'a.js'), '1\n', 'utf8');
  beginTurn(d);
  await edit.run({ path: 'a.js', old_string: '1', new_string: '2' }, d);
  beginTurn(d);
  await edit.run({ path: 'a.js', old_string: '2', new_string: '3' }, d);
  const changes = sessionChanges(d);
  check(
    '3回直しても、出発点は最初の姿のまま',
    changes.length === 1 && changes[0].before === '1\n' && changes[0].after === '3\n',
    JSON.stringify(changes)
  );

  beginTurn(d);
  await write.run({ path: 'b.js', content: 'new\n' }, d);
  const both = sessionChanges(d);
  check('新しく作ったファイルは「新規」として並ぶ', both.some((ch) => ch.created && ch.path.endsWith('b.js')), JSON.stringify(both));
  check('1ファイルだけを指しても引ける', sessionChanges(d, path.join(droot, 'b.js')).length === 1);

  // 戻したファイルは、差分から消える
  undoLastTurn(d);
  check('戻したファイルは差分に残らない', !sessionChanges(d).some((ch) => ch.path.endsWith('b.js')), JSON.stringify(sessionChanges(d)));
}

console.log('\nTab 補完');
{
  const croot = path.join(root, 'comp');
  fs.mkdirSync(path.join(croot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(croot, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(croot, 'src', 'agent.mjs'), '', 'utf8');
  fs.writeFileSync(path.join(croot, 'src', 'app.mjs'), '', 'utf8');
  fs.writeFileSync(path.join(croot, 'readme.md'), '', 'utf8');
  fs.writeFileSync(path.join(croot, '.hidden'), '', 'utf8');

  const opts = {
    root: croot,
    commandNames: () => [...BUILTIN_COMMANDS, 'review'],
    modelNames: () => ['gemma4:26b', 'qwythos:latest']
  };

  let [hits, word] = complete('/mo', opts);
  check('/mo は /model を出す', hits.includes('/model') && word === '/mo', JSON.stringify(hits));

  [hits] = complete('/rev', opts);
  check('自分で作ったコマンドも候補に入る', hits.includes('/review'), JSON.stringify(hits));

  [hits, word] = complete('/model ge', opts);
  check('/model の後はモデル名を出す', hits.includes('gemma4:26b') && word === 'ge', JSON.stringify(hits));

  [hits, word] = complete('@src/a', opts);
  check(
    '@ はファイルを出し、@ を付けたまま返す',
    hits.includes('@src/agent.mjs') && hits.includes('@src/app.mjs') && word === '@src/a',
    JSON.stringify(hits)
  );

  [hits] = complete('この @sr', opts);
  check('フォルダは末尾に / を付けて出す', hits.includes('@src/'), JSON.stringify(hits));

  [hits] = complete('@', opts);
  check('何も打っていないときは node_modules を出さない', !hits.includes('@node_modules/'), JSON.stringify(hits));
  check('何も打っていないときは隠しファイルも出さない', !hits.includes('@.hidden'), JSON.stringify(hits));

  [hits] = complete('@.h', opts);
  check('打てば隠しファイルも出る', hits.includes('@.hidden'), JSON.stringify(hits));

  [hits] = complete('@node_', opts);
  check('自分で打った node_modules は出す', hits.includes('@node_modules/'), JSON.stringify(hits));

  [hits] = complete('ふつうの日本語を打っている', opts);
  check('ふつうの文章では候補を出さない', hits.length === 0, JSON.stringify(hits));

  check('作業フォルダの外は補完しない', completePath('../', croot).length === 0);

  [hits] = complete('@ない場所/x', opts);
  check('無いフォルダを指されても落ちない', Array.isArray(hits) && hits.length === 0);
}

console.log('\nTab 補完 — readline に本当に効くか');
{
  // 偽の端末を作って、補完の道すじを本物のまま通す。
  //
  // complete() を直接呼ぶ検証だけでは、readline に渡し忘れていても気づけない。
  // 実際、端末でないと readline は Tab を**ただの文字として**行に入れる。
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  const screen = [];
  output.on('data', (b) => screen.push(b.toString()));

  const croot = path.join(root, 'comp');
  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    completer: makeCompleter({
      root: croot,
      commandNames: () => BUILTIN_COMMANDS,
      modelNames: () => ['gemma4:26b', 'qwythos:latest']
    })
  });
  const typed = [];
  rl.on('line', (l) => typed.push(l));
  const type = (t) => new Promise((r) => { input.write(t); setImmediate(r); });

  await type('@src/ag\t');
  await type('\n');
  await type('/mod\t');
  await type('\n');
  // 候補が複数のときの作法は bash と同じ。
  //   1回目 … 共通部分まで入る（ここでは @src/a まで）
  //   2回目 … それ以上伸びないので、候補の一覧が出る
  await type('@src/a\t');
  await type('\t');
  await type('\n');
  rl.close();

  check('Tab でファイル名が入る', typed[0] === '@src/agent.mjs', JSON.stringify(typed));
  check('Tab でコマンド名が入る', typed[1] === '/model', JSON.stringify(typed));
  check('候補が複数なら、2回目の Tab で一覧が出る', /agent\.mjs/.test(screen.join('')) && /app\.mjs/.test(screen.join('')));
}

console.log('\n貼り付けのまとめ');
{
  const got = [];
  const buf = createPasteBuffer((text) => got.push(text), { enabled: true, windowMs: 20 });
  buf.push('1行目');
  buf.push('2行目');
  buf.push('3行目');
  await new Promise((r) => setTimeout(r, 60));
  check('続けざまに届いた行は1つにまとまる', got.length === 1 && got[0] === '1行目\n2行目\n3行目', JSON.stringify(got));

  const typed = [];
  const slow = createPasteBuffer((text) => typed.push(text), { enabled: true, windowMs: 20 });
  slow.push('ひとつめ');
  await new Promise((r) => setTimeout(r, 60));
  slow.push('ふたつめ');
  await new Promise((r) => setTimeout(r, 60));
  check('間が空いた行は、別々の依頼のまま', typed.length === 2, JSON.stringify(typed));

  const piped = [];
  const off = createPasteBuffer((text) => piped.push(text), { enabled: false });
  off.push('a');
  off.push('b');
  check('パイプ入力ではまとめない（台本が1つに化けない）', piped.length === 2, JSON.stringify(piped));

  const left = [];
  const closing = createPasteBuffer((text) => left.push(text), { enabled: true, windowMs: 500 });
  closing.push('溜まったまま');
  closing.flush();
  check('入力が閉じても、溜めた行は捨てない', left.length === 1 && left[0] === '溜まったまま', JSON.stringify(left));
}

console.log('\n待ち時間の内訳');
{
  check('速い応答には内訳を出さない', formatTiming({ totalMs: TIMING_FLOOR_MS - 1, evalMs: 400 }) === '');
  const t = formatTiming({ totalMs: 24600, loadMs: 6400, promptMs: 2100, evalMs: 16100, promptTokens: 12000, outputTokens: 618 });
  check('読み込み・前処理・生成に分けて出す', /読み込み 6.4s/.test(t) && /前処理 2.1s/.test(t) && /生成 16.1s/.test(t), t);
  check('生成の速さ（tok/s）を添える', /38.4 tok\/s/.test(t), t);
  const warm = formatTiming({ totalMs: 5000, loadMs: 0, promptMs: 1200, evalMs: 3600, outputTokens: 100 });
  check('常駐していれば読み込みの行は出ない', !/読み込み/.test(warm), warm);
  check('中身が無ければ何も出さない', formatTiming({}) === '' && formatTiming() === '');
}

console.log('\nrun_command — 確認のあとで固まらない');
{
  // 子の標準入力を /dev/null にしていないと、こちらが閉じない書き込み口を子が握ったままになり、
  // 入力を待つコマンドが時間切れ（既定 120 秒）まで戻らない。
  // 実機の「確認に y と答えたあと画面が止まる」の正体がこれだった。
  let t0 = Date.now();
  let r = await run.run({ command: 'cat', timeout_ms: 6000 }, ctx);
  let waited = Date.now() - t0;
  check('入力を待つコマンドで固まらない', waited < 2000 && r.isError === false, `${waited}ms / ${r.display}`);

  t0 = Date.now();
  r = await run.run({ command: 'read -p "pw: " x', timeout_ms: 6000 }, ctx);
  waited = Date.now() - t0;
  check('パスワードを聞くコマンドでも固まらない', waited < 2000, `${waited}ms`);

  // 裏へ回った孫が出力の口を握ったままだと、シェルだけ殺しても close が上がってこない。
  // 孫まで止めないと、時間切れを過ぎても永久に戻らない（実測で 20 秒待っても戻らなかった）。
  t0 = Date.now();
  r = await run.run({ command: 'sleep 60 & echo started', timeout_ms: 1000 }, ctx);
  waited = Date.now() - t0;
  check('裏へ回るコマンドでも時間切れで戻る', waited < 1000 + OUTPUT_DRAIN_MS + 1500, `${waited}ms`);
  check('時間切れはそう伝える', r.display === '時間切れで停止', r.display);

  // 普通のコマンドの扱いは変えていない
  t0 = Date.now();
  r = await run.run({ command: 'echo ok', timeout_ms: 6000 }, ctx);
  waited = Date.now() - t0;
  check('普通のコマンドはそのまま通る', r.isError === false && r.output.includes('ok') && waited < 2000, `${waited}ms / ${r.output}`);

  r = await run.run({ command: 'seq 1 50000 | tail -1', timeout_ms: 6000 }, ctx);
  check('出力の多いコマンドも取りこぼさない', r.output.includes('50000'), r.output.slice(-80));
}

// ── 確認をどこまで飛ばすかの保存 ──────────────────────────
//
// 「毎回ツールの承認を聞かれるのが面倒」なので、/yolo も保存できるようにした。
// 保存できる以上、忘れたまま無防備にならない手当てが要る。ここで固定するのは3つ。
//   1. /save で autoApprove が本当に書かれるか
//   2. 次に起動したとき「保存された設定だ」と分かる形で警告が出るか
//   3. --confirm でその回だけ確認ありに戻せるか
// 起動経路を実機のまま通したいので、偽 Ollama を立てて本物の bin/qwc.mjs を動かす。
console.log('\n確認なしモードの保存と打ち消し');
{
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const qwcBin = path.join(here, '..', 'bin', 'qwc.mjs');

  // 起動時に叩かれる分だけ返す。中身は問われないので最小限
  const fake = http.createServer((req, res) => {
    const body = {
      '/api/version': { version: '0.20.0' },
      '/api/tags': { models: [{ name: 'gemma4:26b' }] },
      '/api/show': { capabilities: ['completion', 'tools', 'thinking'], model_info: {} },
      '/api/ps': { models: [{ name: 'gemma4:26b', size: 100, size_vram: 100 }] },
      '/api/generate': { done: true }
    }[req.url.split('?')[0]] || { done: true };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${fake.address().port}`;

  // 本物の設定ファイルを踏まないよう、HOME ごと仮のものに差し替える
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwc-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qwc-work-'));
  const cfgPath = path.join(home, '.qwythos-code', 'config.json');

  const runQwc = (args, stdin) =>
    new Promise((resolve) => {
      const proc = spawn(process.execPath, [qwcBin, '--host', host, ...args], {
        cwd: work,
        env: { ...process.env, HOME: home },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let seen = '';
      proc.stdout.on('data', (chunk) => { seen += chunk; });
      proc.stderr.on('data', (chunk) => { seen += chunk; });
      proc.stdin.end(stdin);
      const giveUp = setTimeout(() => proc.kill('SIGKILL'), 20000);
      proc.on('close', () => { clearTimeout(giveUp); resolve(seen); });
    });

  const saved = await runQwc([], '/yolo\n/save\n/exit\n');
  const written = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  check('/save は確認なしモードも書き込む', written.autoApprove === true, JSON.stringify(written));
  check('保存したことは黙って済ませない', /確認なしモードも保存しました/.test(saved), saved.slice(-200));

  const again = await runQwc([], '/exit\n');
  check('次の起動でも確認なしのまま', /確認なしモードです/.test(again), again.slice(0, 300));
  check('旗ではなく保存された設定だと分かる', /保存された設定/.test(again), again.slice(0, 300));

  const back = await runQwc(['--confirm'], '/exit\n');
  check('--confirm はその回だけ確認ありに戻す', !/確認なしモードです/.test(back), back.slice(0, 300));
  const stillSaved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  check('--confirm を使っても保存した設定は消えない', stillSaved.autoApprove === true);

  fake.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
}

// ── ツールの往復の上限 ──────────────────────────────────────
//
// 40 では実作業で足りず、途中で壁に当たって「続けて」と打ち直すことになっていた。
// 上限そのものより「どこかに 40 が焼き付いていないか」が怖いので、
// モデルも道具も台本に差し替えて、ループの往復そのものを数える。
console.log('\nツールの往復の上限');
{
  // ひたすら道具を呼び続けるだけの偽モデル。道具の中身は問わないので実行もしない
  class LoopingAgent extends Agent {
    constructor(opts) {
      super(opts);
      this.steps = 0;
    }
    async streamAssistant() {
      this.steps++;
      return {
        message: { role: 'assistant', content: '' },
        toolCalls: [{ name: 'list_dir', args: { path: '.' }, id: `c${this.steps}` }],
        stats: null
      };
    }
    async executeTool() {
      return { output: 'ok', denied: false };
    }
  }

  const stepsUntilStop = async (maxSteps) => {
    const agent = new LoopingAgent({
      // isSubagent にしておくと、上限に当たったときの画面向けの警告が出ない
      config: { ...baseConfig(), maxSteps, isSubagent: true },
      root,
      permissions: new PermissionManager(baseConfig(), async () => 'n')
    });
    await agent.runTurn('ずっと道具を呼び続けて');
    return agent.steps;
  };

  check('既定の上限は 200', baseConfig().maxSteps === 200, String(baseConfig().maxSteps));
  check('40 手を超えても止まらない', (await stepsUntilStop(50)) === 50);
  check('上限は config の数どおりに効く', (await stepsUntilStop(7)) === 7);
}

// ── 出はじめたあとの無音 ────────────────────────────────────
//
// Ollama は道具の呼び出しを書き終えるまで送ってこないので、途中で長い無音が入る。
// 1文字目までは spinner が見ているが、そこから先は誰も見ておらず、画面が固まって見えた。
// 無音のあいだ待ち表示を戻す仕掛けを足したので、それが**中身を壊していない**ことを固定する。
// （表示そのものは端末でないと出ないため、ここで見るのは素通しになっているかどうか）
console.log('\n出はじめたあとに黙り込んでも取りこぼさない');
{
  const http = await import('node:http');

  const gap = QUIET_AFTER_MS + 300;
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { content: 'こんに' } })}\n`);
    // ここで黙り込む＝道具を組み立てているあいだに相当する
    setTimeout(() => {
      res.write(`${JSON.stringify({ message: { content: 'ちは' } })}\n`);
      res.end(`${JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 2 })}\n`);
    }, gap);
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const port = slow.address().port;

  const agent = new Agent({
    config: {
      ...baseConfig(),
      host: `http://127.0.0.1:${port}`,
      model: 'x',
      isSubagent: true,     // 待ち時間の内訳を出さない
      showThinking: 'off',
      maxSteps: 2
    },
    root,
    permissions: new PermissionManager(baseConfig(), async () => 'n')
  });

  const t0 = Date.now();
  await agent.runTurn('こんにちは');
  const waited = Date.now() - t0;
  const said = agent.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('');

  check('無音をはさんでも本文はつながる', said.includes('こんにちは'), said);
  check('無音のぶんは待つ（早すぎず）', waited >= gap, `${waited}ms`);
  check('無音が明けたら普通に終わる', waited < gap + 5000, `${waited}ms`);
  slow.close();
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n合計: ${passed} 件成功 / ${failed} 件失敗\n`);
process.exit(failed ? 1 : 0);
