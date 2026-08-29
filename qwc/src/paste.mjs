// 貼り付けられた複数行を、1つの依頼としてまとめる。
//
// ■ なぜ要るか
//   複数行を貼ると、端末は改行のたびに1行ずつ送ってくる。readline はそれを
//   別々の入力として扱うので、10行のエラーログを貼ると**依頼が10回飛ぶ**。
//   モデルは1行目だけを見て走り出し、残りは順番待ちに積まれる。
//
// ■ なぜ時間で見分けるか
//   貼り付けは一瞬で届き、人が打つ改行は最短でも100ミリ秒は空く。
//   端末に貼り付けの印（bracketed paste）を出させる手もあるが、
//   readline が入力を握っているので横取りが要る。時間で見るほうが素直で、
//   どの端末でも同じように効く。
//
// ■ まとめてよい場面かどうか
//   まとめるのは端末のときだけ。パイプで流し込まれた入力（`printf ... | qwc`）は
//   全行が同じ瞬間に届くので、ここでまとめると台本が丸ごと1つの依頼に化ける。
//   だから `enabled` を外から渡す（この判断はここではできない）。

/** 続けざまに届いた行を、同じ貼り付けとみなす幅（ミリ秒）。 */
export const PASTE_WINDOW_MS = 15;

/**
 * 行を受け取って、まとまったところで `onFlush` に渡す入れ物を作る。
 *
 * @param {(text: string) => void} onFlush まとめた文字列の受け取り先
 * @param {{ enabled?: boolean, windowMs?: number }} options
 * @returns {{ push: (line: string) => void, flush: () => void, pending: () => number }}
 */
export function createPasteBuffer(onFlush, { enabled = true, windowMs = PASTE_WINDOW_MS } = {}) {
  let parts = [];
  let timer = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!parts.length) return;
    const text = parts.join('\n');
    parts = [];
    onFlush(text);
  };

  const push = (text) => {
    // まとめない場でも、この入れ物を通せるようにしておく。
    // 呼ぶ側に「まとめるときだけこちらを使う」という分岐を作ると、
    // 片方だけ直したときに、行の届き方が2通りに割れる。
    if (!enabled) return onFlush(text);
    parts.push(text);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, windowMs);
  };

  return { push, flush, pending: () => parts.length };
}
