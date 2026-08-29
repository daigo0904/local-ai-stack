// 調べものを別のエージェントに任せる。
//
// ■ なぜ要るのか
//     「この機能がどこにあるか探して」を本体にやらせると、
//     読んだファイルの中身が全部そのまま会話に残る。
//     32kの文脈は数ファイルで埋まり、肝心の作業に入る前に要約が始まる。
//     別のエージェントに探させて、**答えだけ**受け取れば、本体の文脈は数行しか減らない。
//
// ■ 読むだけに限る
//     計画モードと同じ道具立てで走らせる。書き換える道具は渡らない。
//     2つのエージェントが同じファイルを同時に書いたら、どちらの結果も信用できなくなる。
//     調べる用途に絞れば、そもそもその事故が起きない。
//
// ■ 入れ子にしない
//     サブエージェントに spawn_agent は渡さない。木が無限に広がるため。

import { Agent } from './agent.mjs';
import { c, line, setOutputPrefix } from './ui.mjs';

/**
 * 頼みごとの伝え方。
 *
 * 役割そのものは system プロンプト側（`RESEARCH_BASE`）に書いてある。
 * ここで同じことを繰り返すと、肝心の質問が長い前置きに埋もれる。
 * 渡すのは質問と、それが会話の外から来たという一言だけにする。
 */
function buildBrief(task) {
  return `Another agent needs this answered. It is the whole of what you were told — there is no earlier conversation to look back on.\n\n${task}`;
}

/**
 * 1つ任せて、答えを返す。
 *
 * 失敗しても投げない。呼び出し側（道具）が理由を文章にしてモデルへ返せるようにする。
 */
export async function runSubagent({ task, config, root, permissions, signal, maxSteps }) {
  const brief = String(task || '').trim();
  if (!brief) return { ok: false, reason: 'task is required.' };

  // 計画モードの道具立て＝読むだけ。書き換える道具は最初から渡らない。
  // isSubagent は spawn_agent 自身を外すために使う（入れ子の防止）。
  const subConfig = {
    ...config,
    planMode: true,
    isSubagent: true,
    // 本体より短く切る。調べるだけなら十数手で足りるし、
    // 長引くほど本体を待たせることになる。
    maxSteps: maxSteps ?? Math.max(6, Math.min(15, Math.floor((config.maxSteps ?? 40) / 3))),
    // 途中経過は見せるが、考えている中身までは流さない（画面が二重になる）
    showThinking: 'off'
  };

  const agent = new Agent({ config: subConfig, root, permissions, onSave: () => {} });

  line();
  line(`${c.magenta('┌')} ${c.bold('調べてきてもらいます')} ${c.gray(brief.slice(0, 60))}`);
  setOutputPrefix(`${c.magenta('│')} `);

  let result;
  try {
    if (signal) {
      // 本体が中断されたら、こちらも止める
      signal.addEventListener('abort', () => agent.interrupt(), { once: true });
    }
    result = await agent.runTurn(buildBrief(brief));
  } catch (err) {
    setOutputPrefix('');
    line(`${c.magenta('└')} ${c.red('調べられませんでした')}`);
    return { ok: false, reason: `The research assistant failed: ${err.message}` };
  } finally {
    setOutputPrefix('');
  }

  const answer = lastAssistantText(agent);
  const steps = agent.stats.toolCalls;
  line(`${c.magenta('└')} ${c.gray(`${steps} 回調べて戻りました`)}`);
  line();

  if (result?.interrupted) {
    return { ok: false, reason: 'The research was interrupted before it finished.' };
  }
  if (!answer) {
    return { ok: false, reason: 'The research assistant came back with nothing.' };
  }
  return { ok: true, answer, steps };
}

/** そのエージェントが最後に言ったこと */
function lastAssistantText(agent) {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.trim();
    }
  }
  return '';
}
