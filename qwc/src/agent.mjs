// エージェント本体。「考える → 道具を使う → 結果を見る」を繰り返す輪の部分。
import fs from 'node:fs';
import path from 'node:path';
import { chatStream, chatOnce } from './ollama.mjs';
import { TOOL_MAP, toolSchemas, truncateOutput } from './tools.mjs';
import { buildSystemPrompt, COMPACT_PROMPT } from './prompt.mjs';
import { classifyInput, SMALL_TALK_HINT } from './smalltalk.mjs';
import { REFINE_PROMPT, applyHarnessEdits, loadHarness } from './harness.mjs';
import { PathError } from './paths.mjs';
import { beginTurn, resetEdits } from './edits.mjs';
import {
  c, line, out, clearLine, supportsAnsi, Spinner, toolHeader, toolResultLine,
  formatMarkdown, termWidth, info, warn, formatTiming
} from './ui.mjs';

// 文字数からだいたいのトークン数を見積もる（日本語混じりを想定して 1トークン≒3文字）
// 出はじめたあと、これだけ無音が続いたら待ち表示を戻す。
// 生成中の普通の切れ目（実測で1秒未満）では出さず、
// 道具を組み立てている本当の無音だけを拾える長さにしてある。
export const QUIET_AFTER_MS = 2000;

function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content || '').length + (m.thinking || '').length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 3);
}

export class Agent {
  constructor({ config, root, permissions, onSave }) {
    this.config = config;
    this.root = root;
    this.permissions = permissions;
    this.onSave = onSave || (() => {});
    this.systemPrompt = buildSystemPrompt({ root, config });
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.abortController = null;
    this.running = false;
    // 道具の呼び出しを本文に書いてしまうモデルか。
    // 1度でもそうと分かったら、以後は本文を出す前に必ず見分ける（画面にJSONを漏らさない）。
    this.writesToolCallsAsText = false;
    this.stats = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, loadMs: 0, promptMs: 0, evalMs: 0, totalMs: 0 };
    this.ctx = {
      root,
      config,
      // 道具から使う。いまは spawn_agent が、任せる相手にそのまま引き継ぐために読む。
      permissions,
      changedFiles: new Set(),
      readFiles: new Set(),
      // ファイルごとの「置き換えに失敗した回数」。
      // 続けて外すようなら、edit_file をやめて丸ごと書き直させる（tools.mjs）。
      editFailures: new Map(),
      // 手を動かした回数（書き込み・置き換え・コマンド実行）。
      // changedFiles は「どのファイルか」の集合なので、同じファイルを2度直しても増えない。
      // 「今回のお願いで実際に何かしたか」を見るには、回数で持つ必要がある。
      mutations: 0,
      // いまのやることリスト。todo_write が書き換える。
      todos: [],
      // 書き換えの控え（`/undo` と `/diff`）。中身は edits.mjs が面倒を見る。
      editLog: [],
      editBaseline: new Map(),
      turnSeq: 0,
      signal: null
    };
  }

  restore(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const rest = messages.filter((m) => m.role !== 'system');
    this.messages = [{ role: 'system', content: this.systemPrompt }, ...rest];
  }

  interrupt() {
    if (this.abortController) this.abortController.abort();
  }

  /**
   * 「手を動かせ」と促してよい場面か。
   *
   * 促しは4種類あるが、どれも「言うだけで動かないモデル」を押すためのもので、
   * 押してよい前提は「作業を頼まれている」こと。雑談にはその前提が無いので、
   * 押すと頼まれてもいないことを無理にやらせることになる。
   *
   * 計画モードと調べもの係の扱いは、これまでどおり促しごとに決める（下の4つ目）。
   * ここでまとめて外すと、書き換えたと嘘をついたときに誰も正せなくなる。
   */
  shouldNudgeToAct() {
    return !(this.ctx.smallTalk || this.config.chatMode);
  }

  /**
   * その道具の呼び出しが、外の世界を変えてしまうか。
   *
   * 雑談として受け取った発言でこれに手が伸びたら、その場で人に聞く。
   * 読むだけの道具（read_file・search_files・web_fetch など）は素通しにする。
   * 雑談の最中に「あのファイルどうなってた？」と聞けなくなるほうが困るし、
   * 読むだけなら外したときの実害が無い。
   */
  touchesTheWorld(tool, args) {
    if (tool.name === 'write_file' || tool.name === 'edit_file') return true;
    if (tool.name === 'run_command') {
      // 聞く相手がいなければ、読み取り専用かどうかも判断させない（そもそもここへ来ない）
      if (!this.permissions) return true;
      return !this.permissions.isSafeCommand(String(args?.command || ''));
    }
    return false;
  }

  rebuildSystemPrompt() {
    this.systemPrompt = buildSystemPrompt({ root: this.root, config: this.config });
    this.messages[0] = { role: 'system', content: this.systemPrompt };
  }

  clear() {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.ctx.changedFiles.clear();
    this.ctx.readFiles.clear();
    this.ctx.editFailures.clear();
    this.ctx.mutations = 0;
    this.ctx.todos = [];
    // 会話をまっさらにしたのに `/undo` が前の作業を戻せてしまうと、
    // 画面に何も残っていないぶん、何が起きたのか分からなくなる。
    resetEdits(this.ctx);
  }

  // ── ひとまとまりのお願いを最後まで処理する ────────────────
  async runTurn(userInput, images = []) {
    // 前のお願いの思考テキストはもう要らない。文脈を空けるために落とす。
    for (const m of this.messages) {
      if (m.role === 'assistant' && m.thinking) delete m.thinking;
    }

    // 画像は Ollama の作法どおり、その発言に添えて送る（base64 の配列）。
    // 前の発言に付いていた画像は落とす。1枚で数十万トークン相当になるため、
    // 残したままだと2枚目を渡した時点で文脈が尽きる。
    for (const m of this.messages) {
      if (m.role === 'user' && m.images) delete m.images;
    }

    // 作業の依頼か、そうでないかを、その場で見分ける。
    //
    // 添えるのは**発言の末尾**で、いちばん上の指示文も道具の一覧も動かさない。
    // 上を動かすと会話を丸ごと読み直すことになり、往復のたびに数秒持っていかれる。
    // /chat と /plan で自分から入っているときは、人が決めた側を優先して判定しない。
    // 別のアプリの中で動いているとき（--embed）もしない。
    // あちらには聞く相手がいない（permissions が無い）ので、外したときに取り返せない。
    const skipAuto =
      this.config.chatMode || this.config.planMode || this.config.isSubagent || !this.permissions;
    const auto = skipAuto ? { smallTalk: false, reason: '' } : classifyInput(userInput);
    this.ctx.smallTalk = auto.smallTalk;
    // 一度「作業です」と答えてもらったら、その発言の残りはもう聞かない
    this.ctx.smallTalkAsked = false;
    if (auto.smallTalk) info(`雑談として受け取ります（${auto.reason}）。書き換えるときは確認します。`);

    const message = { role: 'user', content: auto.smallTalk ? userInput + SMALL_TALK_HINT : userInput };
    if (images.length) message.images = images.map((i) => i.data);
    this.messages.push(message);
    this.stats.turns++;
    // ここから先の書き換えを、ひとまとまりとして控える（`/undo` は1手ではなく1お願い単位で戻す）
    beginTurn(this.ctx);
    this.running = true;
    this.abortController = new AbortController();
    this.ctx.signal = this.abortController.signal;

    const recentCalls = new Map();
    let interrupted = false;
    let nudges = 0;
    // このお願いを受ける前の回数。これと比べて、今回手を動かしたかを見る。
    const mutationsAtStart = this.ctx.mutations || 0;
    // やることリストの促しは1回まで（下の判定で使う）
    let toldAboutTodos = false;
    // 「調べるばかりで進まない」の区切りも1回まで
    let toldToWrapUp = false;
    // 促しても空の返事しか返ってこなかったか（黙って終わらせないための印）
    let emptyEnded = false;
    // このお願いを受ける前の道具の回数。今回どれだけ調べたかを見る
    const toolCallsAtStart = this.stats.toolCalls;

    try {
      for (let step = 0; step < this.config.maxSteps; step++) {
        await this.maybeCompact();

        let result;
        try {
          result = await this.streamAssistant({ step, maxSteps: this.config.maxSteps });
        } catch (err) {
          if (err.name === 'AbortError') {
            interrupted = true;
            break;
          }
          throw err;
        }

        this.messages.push(result.message);
        if (result.stats) {
          this.stats.inputTokens += result.stats.promptTokens || 0;
          this.stats.outputTokens += result.stats.outputTokens || 0;
          // 時間も積む。`/stats` で「今日は前処理ばかりに払っている」が見えるようにするため
          this.stats.loadMs += result.stats.loadMs || 0;
          this.stats.promptMs += result.stats.promptMs || 0;
          this.stats.evalMs += result.stats.evalMs || 0;
          this.stats.totalMs += result.stats.totalMs || 0;
        }

        if (!result.toolCalls.length) {
          const said = result.message.content.trim();

          // 何も言わず、道具も呼ばずに返してきたとき。
          //
          // **ここを step === 0 に限ってはいけない。**
          // 実測: どこを直すか書いていない依頼で6分ぶん読み進めたあと、
          // 67.8秒考えて空を返し、その turn が**画面に1文字も出さないまま終わった**。
          // 利用者から見れば「アバウトに頼むと何も起きない」になる。
          if (!said) {
            if (nudges < (this.config.maxNudges ?? 5)) {
              nudges++;
              this.messages.push({
                role: 'user',
                content:
                  'You returned an empty response. That tells the user nothing. ' +
                  'Say what you have found so far and what you are going to do, ' +
                  'or make the change, or ask one specific question. Do not return empty again.'
              });
              continue;
            }
            // 促しても空のままなら、黙って終わらせない。何が起きたかを人に伝える。
            emptyEnded = true;
            break;
          }

          // 「これからやります」と書くだけで手を動かさないモデルがある。
          // 待っていても永遠に動かないので、その場で促す。
          if (said && this.shouldNudgeToAct() && nudges < (this.config.maxNudges ?? 5) && describesIntentWithoutActing(said)) {
            nudges++;
            info('手順を述べただけで実行していないので、促しました。');
            this.messages.push({
              role: 'user',
              content:
                'You described what you are going to do, but you did not actually use any tool. ' +
                'Nothing happened. Do it now by calling the tools yourself. ' +
                'Do not ask the user to proceed and do not describe the steps again.'
            });
            continue;
          }

          // 「直しました」と過去形で報告しているのに、今回まだ一度も手を動かしていない場合。
          //
          // 上の判定は文章だけを見るので、ここは拾えない（過去形はわざと除外してある。
          // 本当に終わったときまで催促してしまうため）。そこで文章ではなく、
          // 実際に書き換え・実行が起きた回数と突き合わせる。数のほうは嘘をつかない。
          if (
            said &&
            this.shouldNudgeToAct() &&
            nudges < (this.config.maxNudges ?? 5) &&
            (this.ctx.mutations || 0) === mutationsAtStart &&
            claimsWorkDone(said)
          ) {
            nudges++;
            info('やったと報告しましたが、まだ何も変えていないので、促しました。');
            this.messages.push({
              role: 'user',
              content:
                'You reported that you made the change, but you did not call write_file, edit_file, or run_command. ' +
                'The file on disk is unchanged, so nothing was actually done. ' +
                'Make the change now by calling the tool. ' +
                'If you believe no change is needed, say that plainly instead of reporting one you did not make.'
            });
            continue;
          }

          // 直した全文を画面に貼っただけで、保存していない場合。
          // 上の2つと違い、本人は何も主張しない（コードを出しただけ）ので、文章では捕まらない。
          if (
            this.shouldNudgeToAct() &&
            nudges < (this.config.maxNudges ?? 5) &&
            (this.ctx.mutations || 0) === mutationsAtStart
          ) {
            const target = looksLikeFileRewrite(said, this.ctx);
            if (target) {
              nudges++;
              const rel = path.relative(this.root, target) || target;
              info(`書き直した中身を画面に出しただけで保存していないので、促しました（${rel}）。`);
              this.messages.push({
                role: 'user',
                content:
                  `You printed the new version of ${rel} in your reply instead of saving it. ` +
                  'Showing code to the user does not change the file. ' +
                  `Call write_file or edit_file on ${rel} now with that content. ` +
                  'If you only meant to show an example and no change is wanted, say so plainly instead.'
              });
              continue;
            }
          }

          // 「こう直すべきです」と勧めただけで、自分では直していない場合。
          //
          // **計画モードと調べもの係では出さない。**あちらは直さないのが仕事なので、
          // 勧めて終わるのが正しい答えになる。ここで催促すると、できないことを強いることになる。
          if (
            this.shouldNudgeToAct() &&
            nudges < (this.config.maxNudges ?? 5) &&
            !this.config.planMode &&
            !this.config.isSubagent &&
            (this.ctx.mutations || 0) === mutationsAtStart &&
            recommendsWithoutActing(said)
          ) {
            nudges++;
            info('直し方を述べただけで直していないので、促しました。');
            this.messages.push({
              role: 'user',
              content:
                'You described the change that should be made, but you did not make it. ' +
                'The user came to you so that they would not have to do it themselves. ' +
                'Make the change now with edit_file or write_file. ' +
                'If they only asked for your opinion and did not want the file touched, say that plainly instead.'
            });
            continue;
          }

          break;
        }

        let denied = false;
        for (const call of result.toolCalls) {
          if (this.abortController.signal.aborted) {
            interrupted = true;
            break;
          }
          const outcome = await this.executeTool(call, recentCalls);
          this.messages.push({
            role: 'tool',
            tool_name: call.name,
            tool_call_id: call.id,
            content: outcome.output
          });
          if (outcome.denied) denied = true;
        }

        if (interrupted) break;
        if (denied) {
          // 断られたことはモデルに伝わっているので、次の一手を考えさせる
          continue;
        }

        // 長くなってきたのにやることリストが無いときだけ、一度だけ促す。
        //
        // 実測（qwythos 9B）では、5手で終わる作業では自分から todo_write を呼ばなかった。
        // 短い作業ならそれで困らないので、そこは放っておく。
        // 困るのは長い作業で、途中で何を頼まれていたのか見失うとき。
        // 促すのは1回だけ。毎回言うと、そのぶん往復を食って本来の作業が進まない。
        // 調べものを任された側には todo_write を渡していないので、促さない。
        // 無い道具を促すと、呼んで失敗して、その理由を考えるのに往復を2回使う。
        if (
          !toldAboutTodos &&
          !this.config.isSubagent &&
          !this.ctx.todos?.length &&
          this.stats.toolCalls >= (this.config.todoHintAfter ?? 6)
        ) {
          toldAboutTodos = true;
          this.messages.push({
            role: 'user',
            content:
              'This is taking several steps. Call todo_write once with the full list of what is left, ' +
              'so you and the user can both see where this is going. Then carry on.'
          });
          continue;
        }

        // 調べてばかりで、いつまでも結論に進まないとき。
        //
        // ■ どこで見たか
        //   「画面が見にくいから、いい感じにして」のような**どこを直すか書いていない依頼**で、
        //   28ファイルのプロジェクトを7分ぶん読み続け、同じ App.tsx を3回読み直し、
        //   1文字も変えないまま終わった。指示文で「まず絞れ」と言っても、絞り切れずに読み続ける。
        //
        // ■ 何をするか
        //   読んだ量ではなく**結論が出ていないこと**を見て、1度だけ区切りを入れる。
        //   出口は3つ示す（直す・答える・1つ聞く）。**調べものの依頼でも正しい**ようにするため、
        //   「変更しろ」とは言わない。ここで「変更しろ」と言うと、質問しただけの人のファイルを触ってしまう。
        if (
          !toldToWrapUp &&
          !this.config.isSubagent &&
          this.stats.toolCalls - toolCallsAtStart >= (this.config.exploreLimit ?? 10) &&
          (this.ctx.mutations || 0) === mutationsAtStart
        ) {
          toldToWrapUp = true;
          info('調べるばかりで先に進んでいないので、区切りを促しました。');
          this.messages.push({
            role: 'user',
            content:
              `You have used ${this.stats.toolCalls - toolCallsAtStart} tools and changed nothing yet. ` +
              'Stop reading. You have enough to produce a result now. Do exactly one of these:\n' +
              '1. Make the smallest concrete change that improves things, then report it.\n' +
              '2. If the request was a question, answer it from what you have read.\n' +
              '3. If you genuinely cannot tell what they want, ask ONE question naming two or three ' +
              'concrete options you found, with file names.\n' +
              'Do not read another file before doing one of these.'
          });
          continue;
        }

        if (step === this.config.maxSteps - 1) {
          // 任された側の上限は本体より短い。ここで「続けて」と言えるのは人だけなので、
          // 任された側では出さない（そのぶんは呼び出し元が答えの薄さとして受け取る）。
          if (!this.config.isSubagent) {
            warn(`ツールの往復が上限 (${this.config.maxSteps} 回) に達したので止めました。続けるなら「続けて」と言ってください。`);
          }
          this.messages.push({
            role: 'user',
            content: this.config.isSubagent
              ? 'You have run out of tool calls. Answer now with what you actually found, and say plainly what you did not manage to check.'
              : 'You reached the maximum number of tool calls for this turn. Summarize what you did and what is left.'
          });
        }
      }
    } finally {
      this.running = false;
      this.abortController = null;
      this.ctx.signal = null;
      this.onSave();
    }

    // 何も言わないまま終わらせない。
    // 画面に1文字も出ないと、利用者には「固まった」「無視された」としか見えない。
    if (emptyEnded && !interrupted) {
      line();
      warn('モデルが何も返さないまま止まりました。');
      info(
        this.ctx.mutations > 0
          ? 'ここまでの変更は残っています（/files で確認できます）。'
          : '何も変更していません。頼みたいことを、もう少し具体的に（どのファイルの何を、まで）教えてください。'
      );
    }

    if (interrupted) {
      line();
      warn('中断しました。');
      this.messages.push({
        role: 'user',
        content: '[The user interrupted you. Stop what you were doing and wait for the next instruction.]'
      });
    }
    return { interrupted };
  }

  // ── モデルの応答を逐次受け取って画面に出す ────────────────
  async streamAssistant(progress = {}) {
    // 何手目かを添える。
    //
    // 同じ「考えています」が何度も出ると、進んでいるのか同じ所を回っているのか分からない。
    // 上限（既定40）まで見せるのは、どこで打ち切られるかを先に知らせるため。
    const stepLabel = Number.isInteger(progress.step)
      ? `考えています ${progress.step + 1}/${progress.maxSteps ?? this.config.maxSteps}手め`
      : '考えています';
    const spinner = new Spinner(stepLabel).start();
    // 待たされているとき、原因の見当を添える。
    //
    // 実測では、1文字目までが長いときの中身はほぼ2つしかない。
    // モデルの読み込み（冷えていると分単位）と、送った会話の前処理。
    // どちらも「固まった」ではないと分かるだけで、待てるようになる。
    spinner.hint((sec) => {
      if (sec >= 45) return ' — モデルの読み込みか前処理の途中です（/stats で内訳が見られます）';
      if (sec >= 15) return ' — まだ1文字目が来ていません';
      return '';
    });
    let phase = 'idle';
    let lineBuffer = '';
    let thinkStart = Date.now();
    let sawThinking = false;
    // 道具の呼び出しを本文に書いてしまうモデルがある。それを画面に出さないよう、
    // 見分けがつくまで表示を保留する（'unknown' → 'hold' か 'show'）。
    let contentAll = '';
    let shownLen = 0;
    // 本文にJSONを書く癖があると分かっているモデルでは、最初から最後まで保留する。
    // 逐次表示は諦めることになるが、道具の呼び出しを画面に晒すよりはよい。
    let holdDecision = this.writesToolCallsAsText ? 'hold' : 'unknown';

    const flushLine = (text) => {
      line(formatMarkdown(text));
    };

    const rawEvents = chatStream({
      cfg: this.config,
      messages: this.messages,
      tools: toolSchemas(this.ctx.config),
      signal: this.abortController.signal
    });

    // 出はじめたあとにも、黙り込む区間がある。
    //
    // **Ollama は道具の呼び出しを、書き終えるまで送ってこない。**
    // そのあいだ1バイトも届かないので、画面は本当に止まって見える
    // （実測で、道具1つ返すだけのやり取りに14秒の無音があった。
    // 大きなファイルの書き込みなら分単位になる）。
    // 1文字目までは上の spinner が見ているが、そこから先は誰も見ていなかった。
    // 静かになったら待ち表示を戻して、生きていることを示す。
    let quiet = null;
    let quietTimer = null;
    const quietStop = () => {
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      if (quiet) {
        quiet.stop();
        quiet = null;
      }
    };
    const events = (async function* () {
      const iter = rawEvents[Symbol.asyncIterator]();
      let started = false;
      try {
        for (;;) {
          // 1文字目までは上の spinner の担当。二重に出さない
          if (started) {
            quietTimer = setTimeout(() => {
              quiet = new Spinner('道具を組み立てています').start();
              quiet.hint((sec) =>
                sec >= 20 ? ' — 書き終えるまで Ollama は送ってこないので、無音のままです' : ''
              );
            }, QUIET_AFTER_MS);
            if (quietTimer.unref) quietTimer.unref();
          }
          let next;
          try {
            next = await iter.next();
          } finally {
            quietStop();
          }
          if (next.done) return;
          started = true;
          yield next.value;
        }
      } finally {
        quietStop();
      }
    })();

    let final = null;

    for await (const ev of events) {
      if (ev.type === 'thinking') {
        if (phase !== 'thinking') {
          spinner.stop();
          phase = 'thinking';
          thinkStart = Date.now();
          sawThinking = true;
        }
        if (this.config.showThinking === 'full') {
          out(c.gray(ev.text));
        } else if (this.config.showThinking !== 'off' && supportsAnsi) {
          // 直近の一行だけを、その場で書き換えながら見せる
          const flat = ev.text.replace(/\s+/g, ' ');
          this._thinkTail = ((this._thinkTail || '') + flat).slice(-(termWidth() - 14));
          clearLine();
          out(`${c.magenta('✻')} ${c.gray(this._thinkTail)}`);
        }
        continue;
      }

      if (ev.type === 'content') {
        contentAll += ev.text;
        // 別のアプリの中で動いているときは、そちらの画面にも流す。
        // 出来上がるまで黙っていると、相手の画面は止まって見える。
        this.config.onContentDelta?.(ev.text);

        if (holdDecision === 'unknown') {
          const head = contentAll.trimStart();
          if (head) {
            if (!'{[<`'.includes(head[0])) {
              holdDecision = 'show';
            } else if (head.length >= 12 || head.includes('\n')) {
              holdDecision = looksLikeToolCall(head) ? 'hold' : 'show';
            }
          }
        }
        if (holdDecision !== 'show') continue;

        if (phase !== 'content') {
          if (phase === 'thinking') {
            const secs = ((Date.now() - thinkStart) / 1000).toFixed(1);
            if (this.config.showThinking === 'full') {
              line();
            } else {
              clearLine();
            }
            this._thinkTail = '';
            line(c.gray(`✻ ${secs} 秒考えました`));
          }
          spinner.stop();
          phase = 'content';
          line();
        }
        // 保留していた分もここでまとめて流す
        lineBuffer += contentAll.slice(shownLen);
        shownLen = contentAll.length;
        let nl;
        while ((nl = lineBuffer.indexOf('\n')) >= 0) {
          const oneLine = lineBuffer.slice(0, nl);
          // 文章の途中から道具の呼び出しが始まることがある。
          // その行に達したら、そこから先は出さずに保留へ切り替える。
          if (startsToolCallBlock(oneLine)) {
            holdDecision = 'hold';
            break;
          }
          flushLine(oneLine);
          lineBuffer = lineBuffer.slice(nl + 1);
        }
        continue;
      }

      if (ev.type === 'done') {
        // 本文から道具の呼び出しを拾ったなら、このモデルはその癖を持つ
        if (ev.salvaged) this.writesToolCallsAsText = true;
        spinner.stop();
        if (phase === 'thinking') {
          const secs = ((Date.now() - thinkStart) / 1000).toFixed(1);
          clearLine();
          this._thinkTail = '';
          if (sawThinking) line(c.gray(`✻ ${secs} 秒考えました`));
        }
        // 保留していた分の後始末。
        //   道具の呼び出しだった → 出さずに捨てる（画面にJSONを晒さない）
        //   ただの文章だった     → まだ出していない分をここで出す
        if (ev.salvaged) {
          lineBuffer = '';
        } else {
          const unshown = contentAll.slice(shownLen);
          if (unshown) lineBuffer += unshown;
          if (lineBuffer.trim() && phase !== 'content') {
            phase = 'content';
            line();
          }
        }
        if (lineBuffer) {
          flushLine(lineBuffer);
          lineBuffer = '';
        }
        if (phase === 'content') line();
        // かかった時間の内訳。速いときは formatTiming が空を返すので、何も出ない。
        // 任された側（サブエージェント）では出さない。1手ごとに増えると、
        // 誰の作業の話なのか分からないまま行が積み上がる。
        if (!this.config.isSubagent && this.config.showTiming !== false) {
          const timing = formatTiming(ev.stats);
          if (timing) line(c.gray(`  ${timing}`));
        }
        final = ev;
      }
    }

    spinner.stop();
    quietStop();
    if (!final) throw new Error('モデルからの応答が途中で切れました。');
    return final;
  }

  // ── 道具を1つ実行する ──────────────────────────────────────
  async executeTool(call, recentCalls) {
    const tool = TOOL_MAP.get(call.name);
    this.stats.toolCalls++;

    if (!tool) {
      toolHeader(call.name, '');
      toolResultLine(`知らない道具です`, true);
      return {
        output: `Unknown tool "${call.name}". Available tools: ${[...TOOL_MAP.keys()].join(', ')}.`,
        denied: false
      };
    }

    if (call.args && call.args.__parseError !== undefined) {
      toolHeader(tool.name, '');
      toolResultLine('引数のJSONが壊れていました', true);
      return {
        output: 'Your tool arguments were not valid JSON. Call the tool again with correct JSON arguments.',
        denied: false
      };
    }

    // 同じ呼び出しの繰り返しを止める
    const key = `${call.name}:${JSON.stringify(call.args)}`;
    const count = (recentCalls.get(key) || 0) + 1;
    recentCalls.set(key, count);
    if (count > this.config.duplicateLimit) {
      toolHeader(tool.name, summarizeArgs(tool.name, call.args));
      toolResultLine('同じ呼び出しの繰り返しなので止めました', true);
      return {
        output:
          `You have called ${call.name} with these exact arguments ${count} times. ` +
          'The result will not change. Try a different approach, or tell the user what is blocking you.',
        denied: false
      };
    }

    toolHeader(tool.name, summarizeArgs(tool.name, call.args));

    // 別のアプリの中で動いているときは、道具の実体はそちらにある。
    //
    // ここで自分で実行してはいけない。相手には相手の作法（権限・記録・確認）があり、
    // こちらが先に手を出すと、その作法を通らない経路ができてしまう。
    // 確認も持ち主の仕事なので、こちらでは聞かない。判断材料は相手のほうが持っている。
    if (this.config.hostTools) {
      const res = await this.config.hostTools({
        name: tool.name,
        args: call.args || {},
        display: summarizeArgs(tool.name, call.args)
      });
      toolResultLine(res.display || (res.isError ? 'できませんでした' : 'done'), Boolean(res.isError));
      return {
        output: truncateOutput(String(res.output ?? ''), this.config.maxToolChars),
        denied: false
      };
    }

    // 成立しない操作は、確認を出す前にここで弾いてモデルに理由を返す
    if (typeof tool.validate === 'function') {
      let problem = null;
      try {
        problem = tool.validate(call.args || {}, this.ctx);
      } catch (err) {
        problem = err instanceof PathError ? err.message : `${err.name}: ${err.message}`;
      }
      if (problem) {
        toolResultLine('そのままでは適用できません', true);
        return { output: problem, denied: false };
      }
    }

    // 雑談として受け取った発言の途中で、外に影響する道具に手が伸びたとき。
    //
    // 見分けはルールなので、いつか必ず外す。外したときに黙って書き換えるのが
    // いちばん困るので、ここで一度だけ人に聞く。y なら「この発言は作業だった」と
    // みなして、その発言の残りではもう聞かない。
    //
    // 確認なしモード（--yolo）でも聞く。あれは「頼んだ作業を任せる」という意味で、
    // 頼んでもいない雑談でファイルを変えてよい、という意味ではない。
    if (this.ctx.smallTalk && this.touchesTheWorld(tool, call.args)) {
      if (this.ctx.smallTalkAsked) {
        toolResultLine('雑談として受け取っているので実行しません', true);
        return {
          output:
            'The user already said this was not a work request. Do not call this tool again. ' +
            'Answer in words instead, and say what you would change if they want it done.',
          denied: true
        };
      }
      this.ctx.smallTalkAsked = true;
      line();
      line(`${c.brightYellow('┌')} ${c.bold('作業として進めますか')}`);
      line(`${c.brightYellow('│')} ${c.gray(`雑談だと思って受け取りましたが、${tool.name} を使おうとしています。`)}`);
      line(`${c.brightYellow('└')} ${c.gray('y = 作業として進める / n = 答えるだけにしてもらう')}`);
      // 分からない答えは聞き直す。黙って「やめる」に倒すと、
      // 「うん」と答えたのに何も起きなかった、という形で伝わる（実際にそうなった）。
      // 日本語で聞いているので、日本語の返事も受ける。
      let yes = false;
      for (;;) {
        const raw = await this.permissions.ask(`${c.brightYellow('  →')} [y/n] `);
        // 入力が閉じている（-p など）ときは、聞けないので「やめる」扱い
        if (raw === null || raw === undefined) break;
        const answer = String(raw).trim().toLowerCase();
        if (/^(y|yes|うん|はい|ok|おk|そう|お願い|おねがい)/.test(answer) || answer === '') {
          yes = true;
          break;
        }
        if (/^(n|no|いや|いいえ|ちがう|違う|やめ)/.test(answer)) break;
        out(c.gray('  y（作業として進める） か n（答えるだけ） で答えてください。\n'));
      }
      if (yes) {
        // ここから先は普通の作業。書き換えの確認は、いつもどおり別に出る。
        this.ctx.smallTalk = false;
        line();
      } else {
        toolResultLine('答えるだけにします', true);
        return {
          output:
            'The user says this was not a work request. Do not change anything. ' +
            'Answer in words, and if a change would be needed, describe it instead of making it.',
          denied: true
        };
      }
    }

    // 確認が要るかどうか
    let needsApproval = tool.approval === 'always';
    if (tool.approval === 'conditional' && typeof tool.needsApproval === 'function') {
      needsApproval = tool.needsApproval(call.args, this.ctx, this.permissions);
    }

    // 何がどう変わるかを、**実行より先に**作っておく。
    //
    // 書き換えたあとでは、元の中身がもう無いので差分を作れない。
    // 確認を出すときはそこに載せ、確認を出さないとき（--yolo など）は実行後に出す。
    let preview = '';
    if (typeof tool.preview === 'function') {
      preview = safeCall(() => tool.preview(call.args, this.ctx), '');
    }
    // 確認欄として既に画面に出したか。二重に出さないための印
    let previewShown = false;

    if (needsApproval) {
      const title = tool.approvalTitle ? safeCall(() => tool.approvalTitle(call.args, this.ctx), '') : '';
      const decision = await this.permissions.request({
        toolName: tool.name,
        args: call.args,
        title,
        preview
      });
      // 実際に人に見せたときだけ「出した」とみなす。
      // 自動許可（--yolo や記憶した許可）では、何も画面に出ていない。
      previewShown = decision.reason === 'user' || decision.reason === 'always';
      if (!decision.granted) {
        toolResultLine('ユーザーが実行を断りました', true);
        return {
          output:
            'The user denied this action. Do not try it again. ' +
            'Ask what they would prefer, or continue with a different approach.',
          denied: true
        };
      }
      // 実際に人へ聞いたときだけ、確認欄と結果の間に1行あける
      if (decision.reason === 'user' || decision.reason === 'always') line();
    }

    try {
      const res = await tool.run(call.args || {}, this.ctx);
      // 道具が自分で画面に出したときは、結果の行を重ねない（やることリストなど）
      if (!res.quiet) toolResultLine(res.display || 'done', Boolean(res.isError));

      // 書いた中身を画面に出す。
      //
      // 「1 か所を置き換え」だけでは、何がどうなったのか分からない。
      // 確認を出さない設定（--yolo）ほど、ここが唯一の手がかりになる。
      // 確認欄で既に見せているときは重ねない。
      if (tool.showsDiff && preview && !previewShown && !res.isError && this.config.showDiff !== false) {
        for (const l of preview.split('\n')) line(l);
      }

      return {
        output: truncateOutput(String(res.output ?? ''), this.config.maxToolChars),
        denied: false
      };
    } catch (err) {
      const message = err instanceof PathError ? err.message : `${err.name}: ${err.message}`;
      toolResultLine(message.split('\n')[0], true);
      return { output: `Tool error: ${message}`, denied: false };
    }
  }

  // ── 文脈が長くなりすぎたら要約して詰める ──────────────────
  async maybeCompact() {
    const limit = Math.floor(this.config.numCtx * this.config.compactAtRatio);
    if (estimateTokens(this.messages) < limit) return;

    // まず古いツール出力を短くする（これだけで足りることが多い）
    const cutoff = this.messages.length - 8;
    for (let i = 1; i < cutoff; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && m.content && m.content.length > 400) {
        m.content = `${m.content.slice(0, 300)}\n…[古い出力のため省略]`;
      }
    }
    if (estimateTokens(this.messages) < limit) {
      info('古いツール出力を短くして文脈を空けました。');
      return;
    }

    await this.compact();
  }

  async compact() {
    const keep = 6;
    if (this.messages.length <= keep + 2) return;

    // 切れ目がツール結果の途中に来ると、呼び出しだけ消えた履歴になってしまう。
    // 残す側の先頭がツール結果でなくなるまで境界をずらす。
    let start = this.messages.length - keep;
    while (start < this.messages.length - 1 && this.messages[start].role === 'tool') start++;

    const head = this.messages[0];
    const middle = this.messages.slice(1, start);
    const tail = this.messages.slice(start);

    const transcript = middle
      .map((m) => {
        if (m.role === 'tool') return `[tool ${m.tool_name}] ${String(m.content).slice(0, 600)}`;
        if (m.role === 'assistant' && m.tool_calls) {
          return `[assistant used tools] ${m.tool_calls.map((t) => t.function.name).join(', ')} ${m.content || ''}`;
        }
        return `[${m.role}] ${m.content || ''}`;
      })
      .join('\n')
      .slice(-40000);

    const spinner = new Spinner('これまでのやり取りを要約中').start();
    let summary = '';
    try {
      summary = await chatOnce({
        cfg: this.config,
        messages: [
          { role: 'system', content: COMPACT_PROMPT },
          { role: 'user', content: transcript }
        ]
      });
    } catch {
      summary = '';
    }
    spinner.stop();

    if (!summary.trim()) {
      // 要約できなければ古い部分を捨てるだけにする
      this.messages = [head, ...tail];
      warn('要約に失敗したので、古いやり取りを切り捨てました。');
      return;
    }

    // 要約はモデルが書くので取り違えが混じる。実際に触ったファイルは事実として添える。
    const facts = [];
    const changed = [...this.ctx.changedFiles].map((f) => path.relative(this.root, f));
    const read = [...this.ctx.readFiles].map((f) => path.relative(this.root, f)).filter((f) => !changed.includes(f));
    if (changed.length) facts.push(`Files actually written in this session: ${changed.join(', ')}`);
    if (read.length) facts.push(`Files actually read (not modified): ${read.slice(0, 20).join(', ')}`);
    if (!changed.length) facts.push('No file has been written in this session yet.');

    this.messages = [
      head,
      {
        role: 'user',
        content:
          `[Summary of the earlier part of this session]\n${summary.trim()}\n\n` +
          `[Verified facts recorded by the tool runner — these override the summary above]\n${facts.join('\n')}`
      },
      { role: 'assistant', content: 'Understood. Continuing from there.' },
      ...tail
    ];
    info('文脈が長くなったので、これまでの内容を要約して続けます。');
  }

  /**
   * いまのやり取りを見直して、覚えておくことを直す。
   *
   * 覚えるのはモデルだが、**何を覚えてよいかはこちらが決める**（REFINE_PROMPT）。
   * 際限なく足させると、当たらない思い込みが毎ターンの固定費として積み上がるため。
   *
   * 基礎の指示文には一切触れない。足すのは別の層だけ。
   */
  async refine(instructions = '') {
    const transcript = this.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') return `[tool ${m.tool_name}] ${String(m.content).slice(0, 400)}`;
        if (m.role === 'assistant' && m.tool_calls) {
          return `[assistant used tools] ${m.tool_calls
            .map((t) => `${t.function.name}(${JSON.stringify(t.function.arguments).slice(0, 120)})`)
            .join(', ')} ${m.content || ''}`;
        }
        return `[${m.role}] ${m.content || ''}`;
      })
      .join('\n')
      .slice(-30000);

    if (!transcript.trim()) return { applied: [], reason: 'まだ何のやり取りもありません。' };

    // いま覚えていることも渡す。渡さないと同じことを何度も足してくる。
    const current = JSON.stringify(loadHarness(this.root));
    const ask = [
      `Existing notes (do not duplicate these): ${current}`,
      instructions ? `The user asks you to focus on: ${instructions}` : '',
      '',
      'Session transcript:',
      transcript
    ]
      .filter(Boolean)
      .join('\n');

    let raw = '';
    try {
      raw = await chatOnce({
        cfg: this.config,
        messages: [
          { role: 'system', content: REFINE_PROMPT },
          { role: 'user', content: ask }
        ]
      });
    } catch (err) {
      return { applied: [], reason: `見直せませんでした: ${err.message}` };
    }

    const edits = parseEdits(raw);
    if (!edits) return { applied: [], reason: '返事が読めませんでした（JSON ではありませんでした）。' };
    if (!edits.length) return { applied: [], reason: '覚えておくほどのことはありませんでした。' };

    const applied = applyHarnessEdits(this.root, edits);
    // いまのセッションにもすぐ効かせる
    if (applied.length) this.rebuildSystemPrompt();
    return { applied, reason: applied.length ? '' : '当てられる変更がありませんでした。' };
  }

  changedFileList() {
    return [...this.ctx.changedFiles];
  }
}

// 「これからこうします」と述べただけで、実際には何もしていない返答か。
//
// 道具を呼ばずにターンを終えた返答だけに対して使う。
// 過去形の報告（直しました・実行しました）は対象外にしないと、正しい完了報告まで促してしまう。
//
// 語尾の「します。」を入れてはいけない。
// 「その合計金額を返します。」のような**コードの説明文**がことごとく当たり、
// 正しく答えたあとに催促が出て、答えを打ち消す返事に化ける（実機で観測）。
// 拾ってよいのは、コードの説明には現れない言い回しだけ。
export function describesIntentWithoutActing(text) {
  const intent =
    /(\bI will\b|\bI'll\b|\blet me\b|\blet's\b|\bI am going to\b|\bI'm going to\b|\bnext,? I\b|please proceed|proceed with|\bStep 1\b|これから|次に|してください|していきます|してみます|しましょう|やります|する予定)/i;
  const done =
    /(\bI (have |already )?(changed|edited|fixed|created|ran|verified|updated)\b|\bnow pass(es|ed)?\b|しました|直しました|作成しました|確認しました|通りました)/i;

  // 判定は「最後の一文」で行う。
  // 「直しました。次にテストを実行します。」のように完了報告と次の宣言が同居することがあり、
  // 全文で見ると完了報告に引っぱられて、動いていないのに終わったと誤認してしまう。
  const sentences = text.trim().split(/(?<=[.。!?！？])\s*|\n+/).filter((s) => s.trim());
  if (!sentences.length) return false;

  const last = sentences[sentences.length - 1];
  if (intent.test(last)) return !done.test(last);

  // 最後の一文が短すぎて判断できないときだけ、1つ前も併せて見る
  if (last.trim().length < 15 && sentences.length > 1) {
    const merged = `${sentences[sentences.length - 2]} ${last}`;
    return intent.test(merged) && !done.test(merged);
  }
  return false;
}

/**
 * 見直しの返事から、差し引きの一覧を取り出す。
 *
 * 「JSON だけ返せ」と書いても、小さいモデルは前置きを付けたり ``` で囲んだりする。
 * そこで、まるごと読めなければ最初の `{`〜最後の `}` を切り出して読み直す。
 * それでも駄目なら null（＝読めなかった）を返す。**当て推量では当てない。**
 */
export function parseEdits(raw) {
  const text = String(raw ?? '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [text.trim()];
  if (fenced) candidates.unshift(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  const normalize = (edits) =>
    edits
      .filter((e) => e && typeof e === 'object' && ['create', 'update', 'delete'].includes(e.op))
      .map((e) => ({ ...e, scope: e.scope === 'global' ? 'global' : 'project' }));

  for (const candidate of candidates) {
    if (!candidate) continue;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const edits = Array.isArray(parsed) ? parsed : parsed?.edits;
    if (!Array.isArray(edits)) continue;
    // 形の合わないものは捨てる。置き場の指定が無いものは project 扱いにする
    return normalize(edits);
  }

  // ここまで来たら JSON としては壊れている。
  //
  // 実機で見た壊れ方は決まっていて、**中の文にコマンドを引用符ごと書いてしまう**もの。
  //   "evidence":"run_command({"command":"node test_cart.js"}) を実行した"
  // これで JSON 全体が読めなくなり、良い覚え書きまで丸ごと捨てることになる。
  // 鍵の名前は決まっているので、そこを頼りに1つずつ拾い直す。
  const salvaged = salvageEdits(text);
  return salvaged.length ? normalize(salvaged) : null;
}

/** 壊れた JSON から、決まった鍵だけを頼りに拾い直す */
function salvageEdits(text) {
  const KEYS = 'op|scope|id|text|evidence';
  // 値の終わりは「次の鍵が続く引用符」か「閉じ括弧の直前の引用符」だけと見なす。
  // 中に引用符が混ざっていても、そこでは切らない。
  const field = (slice, key) => {
    const re = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?=,\\s*"(?:${KEYS})"|\\}|$)`);
    const m = slice.match(re);
    return m ? m[1] : undefined;
  };

  // "op" ごとに区切る。1件ぶんの塊にしてから、その中だけを見る
  const starts = [...text.matchAll(/"op"\s*:/g)].map((m) => m.index);
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const slice = text.slice(starts[i], starts[i + 1] ?? text.length);
    const op = field(slice, 'op');
    if (!op) continue;
    const edit = { op };
    for (const key of ['scope', 'id', 'text', 'evidence']) {
      const value = field(slice, key);
      if (value !== undefined) edit[key] = value;
    }
    out.push(edit);
  }
  return out;
}

// 「変えました」と報告しているか。
//
// describesIntentWithoutActing とは逆側の判定。あちらは「これからやります」を拾い、
// こちらは「やりました」を拾う。呼び出し側で実際の回数と突き合わせて初めて意味を持つので、
// この関数だけでは何も断定しない。
//
// 拾うのは「中身を変えた」と言っている場合だけに絞る。
// 「確認しました」「読みました」は手を動かさなくても成り立つ正しい報告なので入れない。
export function claimsWorkDone(text) {
  const claim =
    /(\bI (have |already |just )?(changed|edited|fixed|created|updated|added|removed|deleted|replaced|renamed|wrote|implemented|applied)\b|\bhas been (changed|edited|fixed|created|updated|added|removed|replaced|applied)\b|\bthe (fix|change|edit) (is|has been) applied\b|修正しました|直しました|変更しました|書き換えました|作成しました|追加しました|削除しました|更新しました|置き換えました|実装しました|反映しました|修正済み|変更済み)/i;

  // 打ち消しの言い回しは除く。
  // 「まだ修正していません」「修正しませんでした」を完了報告として拾うと、
  // 正しく手を止めている場面で催促してしまう。
  const negated = /(していません|しませんでした|できませんでした|しないでください|必要ありません|\bdid not\b|\bdo not\b|\bhave not\b|\bcannot\b|\bcould not\b|\bno (change|edit|fix)s? (is|are|was|were) needed\b)/i;

  // 判定は文ごとに行う。全文で打ち消しを見ると
  // 「修正しました。テストは実行していません。」のような並びで、
  // 正しい完了報告のほうまで打ち消されてしまう。
  const sentences = text.trim().split(/(?<=[.。!?！？])\s*|\n+/).filter((s) => s.trim());
  return sentences.some((s) => claim.test(s) && !negated.test(s));
}

/**
 * 「こう直すべきです」と勧めただけで、自分では直していない返事か。
 *
 * ■ これが一番の外し方
 *   利用者に「税率が古いよ」と言われて、「はい、0.08 を 0.1 に変えるべきです」と答えて終わる。
 *   コーディングを頼む道具なのに、**毎回「直して」と言い直させることになる**。
 *
 *   上の2つとは別物。describesIntentWithoutActing は「これからやります」（自分がやる宣言）、
 *   claimsWorkDone は「やりました」（嘘の完了報告）。こちらは**そもそも自分がやる気が無い**返事。
 *
 * ■ 拾ってはいけない場合
 *   「どう直すべき？」と意見を求められたときは、勧めるのが正しい答え。
 *   呼ぶ側で、計画モードと調べもの係を外してから使うこと（あちらは直さないのが仕事）。
 */
export function recommendsWithoutActing(text) {
  const advice =
    /(すべきです|すべきでしょう|する必要があります|したほうがよい|したほうがいい|修正が必要|変更が必要|直す必要|変更してください|修正してください|に変えてください|\bshould be (changed|updated|fixed|replaced)\b|\bneeds? to be (changed|updated|fixed)\b|\byou (can|could|should) (change|update|fix|replace)\b|\bI recommend\b|\bwould need to\b)/i;

  // 自分で手を動かした話をしているなら、勧めているだけではない
  const acted =
    /(しました|直しました|変更しました|修正しました|置き換えました|作成しました|\bI (have |already |just )?(changed|edited|fixed|updated|replaced|created)\b)/i;

  const sentences = text.trim().split(/(?<=[.。!?！？])\s*|\n+/).filter((s) => s.trim());
  return sentences.some((s) => advice.test(s)) && !sentences.some((s) => acted.test(s));
}

// 返事の中の ``` で囲まれた塊を取り出す
function fencedBlocks(text) {
  const blocks = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  return blocks;
}

// 「直したファイルの全文」を画面に貼っただけの返事か。
//
// 実機で一番多い外し方がこれ。read_file で読んだあと、書き直した全文を ``` で囲んで出して終わる。
// 本人は仕事をした気でいるが、ファイルは元のままなので、何も起きていない。
//
// 例として短い断片を見せているだけの場合と区別するために、
// 「今回読んだファイルの中身が、その塊にほぼ丸ごと入っているか」で見る。
// 説明のための引用なら数行しか重ならず、書き直した全文なら元の行がそのまま残るため、はっきり分かれる。
export function looksLikeFileRewrite(text, ctx) {
  const blocks = fencedBlocks(text);
  if (!blocks.length) return null;

  // 意味のある行だけを比べる。閉じ括弧や空行は、どのファイルにもあるので当てにならない。
  const meaningful = (src) =>
    src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 8 && !/^[)}\];,]+$/.test(l));

  for (const file of ctx.readFiles || []) {
    let original;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 200000) continue;
      original = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 消えていたり読めないものは飛ばす
    }
    const lines = meaningful(original);
    if (lines.length < 3) continue; // 短すぎるファイルは判定できない

    for (const block of blocks) {
      const inBlock = new Set(meaningful(block));
      const hit = lines.filter((l) => inBlock.has(l)).length;
      if (hit / lines.length >= 0.6) return file;
    }
  }
  return null;
}

// 本文の書き出しが、道具の呼び出しに見えるか
function looksLikeToolCall(head) {
  return /^(<tool_call>|```(?:json)?\s*[[{]|[[{]\s*"?(name|tool|function)"?\s*:)/.test(head);
}

// その1行から、道具の呼び出しの塊が始まっていそうか。
// 本物のコード例（```json …）まで拾ってしまうが、道具でなければ最後にまとめて出すので消えはしない。
function startsToolCallBlock(oneLine) {
  const t = oneLine.trimStart();
  return /^(<tool_call>|```(?:json)?\s*$|```(?:json)?\s*[[{]|[[{]\s*"?(name|tool|function)"?\s*:)/.test(t);
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return typeof fallback === 'string' ? `${fallback}${err.message}` : fallback;
  }
}

// ツール名ごとに「何をしようとしているか」を1行で見せる
function summarizeArgs(name, args = {}) {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(args.path || '');
    case 'list_dir':
      return String(args.path || '.');
    case 'search_files':
      // glob も出す。これが無いと「一致なし」の理由が画面から追えない。
      return [
        args.pattern || '',
        args.path ? ` in ${args.path}` : '',
        args.glob ? ` glob:${args.glob}` : ''
      ].join('');
    case 'run_command': {
      const cmd = String(args.command || '');
      return cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd;
    }
    default:
      return Object.keys(args).length ? JSON.stringify(args).slice(0, 60) : '';
  }
}
