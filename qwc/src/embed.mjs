// 別のアプリの中で、エンジンとして使われるための口。
//
// ■ 何のためにあるのか
//     qwc の値打ちは、道具そのものではなく**ループのほう**にある。
//     考える→道具を使う→結果を見る、の輪と、そこに積んだ受け皿
//     （本文救済・促し・やることリスト・計画モード・調べもの委譲）が中身。
//
//     ところが、これを別のアプリに入れようとすると道具で行き詰まる。
//     入れる先には、たいてい**自前の作法**がある。
//     Omnical AI なら「ファイルに触れる処理は必ず安全層を通す」がそれで、
//     qwc が自分で `fs.writeFileSync` を呼んだ時点で、その約束は破れる。
//
//     そこで、この口では**道具の実体をぜんぶ相手側に返す**。
//     qwc は「read_file を this の引数で呼びたい」と言うだけで、
//     実際に読むのは相手のアプリ。結果だけを受け取って輪を回す。
//     ループはこちら、権限と記録はあちら。どちらの作法も壊れない。
//
// ■ 話し方
//     行ごとの JSON を、標準入力と標準出力でやりとりする（JSON Lines）。
//     追加のライブラリは要らないし、どの言語からでも読める。
//
//     相手 → qwc
//       {"type":"hello","tools":["read_file",…],"root":"…","model":"…"}
//       {"type":"user","text":"…"}
//       {"type":"tool_result","id":"…","output":"…","isError":false}
//       {"type":"interrupt"}
//       {"type":"bye"}
//
//     qwc → 相手
//       {"type":"ready","tools":[…]}          いま模型に見せている道具
//       {"type":"thinking","delta":"…"}
//       {"type":"text","delta":"…"}
//       {"type":"tool_request","id":"…","name":"…","args":{…},"display":"…"}
//       {"type":"todos","items":[…]}
//       {"type":"turn_end","text":"…","interrupted":false}
//       {"type":"error","message":"…"}
//
// ■ 画面には何も出さない
//     この口を使っているあいだ、色つきの表示は1文字も出さない。
//     混ざると相手が JSON を読めなくなる。ui.mjs 側で黙らせている。

import readline from 'node:readline';

/** 相手からの返事を待っている道具の呼び出し */
const waiting = new Map();

let send = () => {};
let nextId = 1;

/** 1行の JSON を送る */
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * 道具を1つ、相手にやってもらう。
 *
 * 返ってくるまで待つ。相手が落ちたら待ち続けることになるので、
 * 入力が閉じた時点で待っているものは全部断る（下の close で拾う）。
 */
export function requestTool({ name, args, display }) {
  const id = `t${nextId++}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    write({ type: 'tool_request', id, name, args: args || {}, display: display || '' });
  });
}

/** 途中経過を伝える。相手が画面に出すかどうかは相手が決める。 */
export const emit = {
  thinking: (delta) => write({ type: 'thinking', delta }),
  text: (delta) => write({ type: 'text', delta }),
  todos: (items) => write({ type: 'todos', items }),
  error: (message) => write({ type: 'error', message })
};

/**
 * 口を開けて、相手の指示を待ち続ける。
 *
 * @param handlers.onHello 最初の挨拶。ここでエージェントを組み立ててもらう
 * @param handlers.onUser  頼みごと。1つ処理し終えるまで次は受け取らない
 * @param handlers.onInterrupt 中断
 */
export async function serve({ onHello, onUser, onInterrupt, onGone }) {
  send = write;

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  // 相手の頼みごとは順番に片づける。
  // 前の作業が終わらないうちに次を始めると、会話が混ざって辻褄が合わなくなる。
  let queue = Promise.resolve();
  let greeted = false;

  rl.on('line', (raw) => {
    const text = raw.trim();
    if (!text) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      emit.error(`読めない行が届きました: ${text.slice(0, 120)}`);
      return;
    }

    switch (message.type) {
      case 'hello':
        if (greeted) return;
        greeted = true;
        queue = queue.then(() => onHello(message)).catch((err) => emit.error(err.message));
        break;

      case 'user':
        queue = queue
          .then(() => onUser(message))
          .catch((err) => {
            emit.error(err.message);
            write({ type: 'turn_end', text: '', interrupted: false });
          });
        break;

      case 'tool_result': {
        const resolve = waiting.get(message.id);
        if (!resolve) return; // 知らない id は捨てる（前の作業の取り残しなど）
        waiting.delete(message.id);
        resolve({
          output: String(message.output ?? ''),
          isError: Boolean(message.isError),
          display: message.display || ''
        });
        break;
      }

      case 'interrupt':
        onInterrupt?.();
        break;

      case 'bye':
        rl.close();
        break;

      default:
        emit.error(`知らない種類です: ${message.type}`);
    }
  });

  await new Promise((resolve) => {
    rl.on('close', () => {
      // 相手がいなくなったのに待ち続けない。待っているものは全部断って輪を終わらせる。
      for (const [id, resolve] of waiting) {
        resolve({ output: 'The host disconnected before this tool finished.', isError: true });
        waiting.delete(id);
      }
      // 考えている途中なら、それも止める。
      // 止めないと、相手が閉じたあともモデルを抱えたまま居座り続ける
      // （実際に、落ちたアプリのぶんだけ居残っているのを見た）。
      onGone?.();
      resolve();
    });
  });
}

/** 1回分の頼みごとが済んだことを伝える */
export function turnEnd(text, interrupted = false) {
  write({ type: 'turn_end', text: text || '', interrupted: Boolean(interrupted) });
}

/** 支度ができたことを伝える。いま模型に見せている道具の名前を添える。 */
export function ready(tools) {
  write({ type: 'ready', tools });
}
