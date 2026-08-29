// 本物のブラウザを動かす部分。ログインが要るページを読むためのもの。
//
// ■ 考え方
//     パスワードは qwc に渡さない。渡さないので、漏らしようがない。
//     あなたが本物のブラウザで手を使ってログインし、その「ログイン済みの状態」だけを
//     このフォルダに残す。以後 qwc は同じ状態のブラウザでページを開く。
//
//     残るもの: Cookie とログイン状態（ブラウザが管理する形のまま）
//     残らないもの: パスワード、入力した文字、ページの中身
//
// ■ Playwright は任意
//     入っていなければ、この機能は丸ごと無かったことにして動き続ける。
//     道具そのものをモデルへ渡さないので、呼べないものを呼んで失敗することはない。

import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.mjs';

/** ログイン状態を置く場所。ここに本物の Cookie が入る。 */
export const PROFILE_DIR = path.join(HOME_DIR, 'browser');

/** 入っていないときの案内 */
export const INSTALL_HELP =
  'ブラウザ操作には Playwright が要ります。次を一度だけ実行してください。\n' +
  '  cd ~/qwythos-code && npm install playwright && npx playwright install chromium';

let cachedModule;

/** Playwright が使えるか。使えなければ null。 */
export async function loadPlaywright() {
  if (cachedModule !== undefined) return cachedModule;
  try {
    const mod = await import('playwright');
    cachedModule = mod?.chromium ? mod : null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export async function isAvailable() {
  return (await loadPlaywright()) !== null;
}

function ensureProfileDir() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  try {
    // 中身は本物のログイン状態なので、他の利用者から読めないようにする
    fs.chmodSync(PROFILE_DIR, 0o700);
  } catch {
    /* 権限を変えられない環境では諦める */
  }
  return PROFILE_DIR;
}

// ブラウザの作業フォルダは同時に1つしか開けない。
// ログイン中に取得が走ると壊れるので、順番に流す。
let queue = Promise.resolve();
function serialize(task) {
  const next = queue.then(task, task);
  // 失敗しても列は止めない
  queue = next.then(() => undefined, () => undefined);
  return next;
}

// 画面なしで動かすと、既定では「自動で動かしています」と名乗ってしまう。
//   ・navigator.webdriver が true になる
//   ・UA に HeadlessChrome と入る
// これを見て「ログインし直してください」と突き返すサイトがあり、
// せっかく保存したログイン状態が使えなくなる。名乗りだけをふつうのブラウザに揃える。
//
// これはあなた自身のブラウザで、あなた自身のアカウントの、あなた自身のページを開くためのもの。
// サイトの利用規約に反する使い方をしてよい、という意味ではない。
let cachedUserAgent;

async function normalUserAgent(playwright) {
  if (cachedUserAgent !== undefined) return cachedUserAgent;
  try {
    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    await browser.close();
    cachedUserAgent = String(ua).replace(/HeadlessChrome/g, 'Chrome');
  } catch {
    cachedUserAgent = null;
  }
  return cachedUserAgent;
}

async function openContext(playwright, { headless }) {
  const options = {
    headless,
    viewport: { width: 1280, height: 900 },
    args: headless
      ? ['--disable-blink-features=AutomationControlled']
      : ['--disable-blink-features=AutomationControlled', '--start-maximized']
  };

  // 画面ありのときは、もともとふつうの名乗りなので触らない
  if (headless) {
    const ua = await normalUserAgent(playwright);
    if (ua) options.userAgent = ua;
  }

  return playwright.chromium.launchPersistentContext(ensureProfileDir(), options);
}

/** URL に scheme が無ければ https を補う */
function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z]+:\/\//i.test(text)) return null; // file:// などは受けない
  return `https://${text}`;
}

/**
 * 手でログインしてもらう。
 *
 * 画面つきのブラウザを開いて、そのまま待つ。
 * qwc はキーボード入力にも画面の中身にも触らない。終わったかどうかは人が教える。
 */
export async function login(target, { waitForUser }) {
  const playwright = await loadPlaywright();
  if (!playwright) return { ok: false, reason: INSTALL_HELP };

  const url = normalizeUrl(target);
  if (!url) return { ok: false, reason: `開けないアドレスです: ${target}` };

  return serialize(async () => {
    let ctx;
    try {
      ctx = await openContext(playwright, { headless: false });
    } catch (err) {
      return { ok: false, reason: `ブラウザを開けませんでした: ${err.message.split('\n')[0]}` };
    }

    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {
        /* 開けなくても、人が手で別のページへ行けるので止めない */
      });

      // ここで待つ。閉じるのは人が「終わった」と言ってから。
      await waitForUser();

      const host = new URL(url).host;
      const cookies = await ctx.cookies().catch(() => []);
      const forHost = cookies.filter((ck) => String(ck.domain || '').replace(/^\./, '').endsWith(hostRoot(host)));
      return { ok: true, host, cookieCount: forHost.length };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });
}

function hostRoot(host) {
  const parts = String(host).split('.').filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

/**
 * ページを開いて、見えている文字を返す。
 *
 * 保存済みのログイン状態をそのまま使うので、ログインが要るページも読める。
 * JavaScript で描くページも、描き終わったあとの文字が取れる。
 */
export async function browse(target, { timeoutMs = 30000, maxChars = 40000 } = {}) {
  const playwright = await loadPlaywright();
  if (!playwright) return { ok: false, reason: INSTALL_HELP };

  const url = normalizeUrl(target);
  if (!url) return { ok: false, reason: `開けないアドレスです: ${target}` };

  return serialize(async () => {
    let ctx;
    try {
      ctx = await openContext(playwright, { headless: true });
    } catch (err) {
      return { ok: false, reason: `ブラウザを開けませんでした: ${err.message.split('\n')[0]}` };
    }

    try {
      const page = await ctx.newPage();
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      // 描き終わるまで少しだけ待つ。待ちきれなくても、その時点の中身を返す。
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);

      const title = await page.title().catch(() => '');
      const finalUrl = page.url();
      const status = res ? res.status() : 0;

      const text = await page
        .evaluate(() => {
          for (const el of document.querySelectorAll('script,style,noscript,svg')) el.remove();
          return document.body ? document.body.innerText : '';
        })
        .catch(() => '');

      const cleaned = String(text).replace(/\n{3,}/g, '\n\n').trim();
      const truncated = cleaned.length > maxChars;

      return {
        ok: true,
        url: finalUrl,
        title,
        status,
        text: truncated ? `${cleaned.slice(0, maxChars)}\n\n…[以降を省略しました]` : cleaned,
        truncated
      };
    } catch (err) {
      const msg = err?.message?.split('\n')[0] || String(err);
      return { ok: false, reason: `${url} を開けませんでした: ${msg}` };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });
}

// 道具（browser_login）から使う、開きっぱなしのログイン。
//
// スラッシュコマンドの /login は「開く→人を待つ→閉じる」を1回で書けるが、
// 道具はモデルの呼び出し1回で返さないといけないので、人を待てない。
// そこで「開ける」と「終わる」を2回に分け、その間ブラウザを持っておく。
let pendingLogin = null;

/** ログイン用のブラウザを開いて、開いたまま返す。 */
export async function openForLogin(target) {
  const playwright = await loadPlaywright();
  if (!playwright) return { ok: false, reason: INSTALL_HELP };

  const url = normalizeUrl(target);
  if (!url) return { ok: false, reason: `開けないアドレスです: ${target}` };
  if (pendingLogin) return { ok: false, reason: 'すでにログイン用のブラウザが開いています。終わったらそう伝えてください。' };

  let ctx;
  try {
    ctx = await openContext(playwright, { headless: false });
  } catch (err) {
    return { ok: false, reason: `ブラウザを開けませんでした: ${err.message.split('\n')[0]}` };
  }

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {
      /* 開けなくても、人が手で別のページへ行ける */
    });
  } catch {
    /* 同上 */
  }

  pendingLogin = { ctx, host: new URL(url).host };
  return { ok: true, host: pendingLogin.host };
}

/** 開いていたブラウザを閉じて、ログイン状態を確定させる。 */
export async function finishLogin() {
  if (!pendingLogin) return { ok: false, reason: 'ログイン用のブラウザは開いていません。' };
  const { ctx, host } = pendingLogin;
  pendingLogin = null;
  let cookieCount = 0;
  try {
    cookieCount = (await ctx.cookies().catch(() => [])).length;
  } finally {
    await ctx.close().catch(() => undefined);
  }
  return { ok: true, host, cookieCount };
}

export function loginInProgress() {
  return Boolean(pendingLogin);
}

/** ログイン状態が残っているサイトの一覧。中身（値）は出さない。 */
export async function savedSites() {
  const playwright = await loadPlaywright();
  if (!playwright) return { ok: false, reason: INSTALL_HELP };
  if (!fs.existsSync(PROFILE_DIR)) return { ok: true, sites: [] };

  return serialize(async () => {
    let ctx;
    try {
      ctx = await openContext(playwright, { headless: true });
    } catch (err) {
      return { ok: false, reason: `ブラウザを開けませんでした: ${err.message.split('\n')[0]}` };
    }
    try {
      const cookies = await ctx.cookies().catch(() => []);
      const byHost = new Map();
      for (const ck of cookies) {
        const host = String(ck.domain || '').replace(/^\./, '');
        if (!host) continue;
        byHost.set(host, (byHost.get(host) || 0) + 1);
      }
      const sites = [...byHost.entries()]
        .map(([host, count]) => ({ host, count }))
        .sort((a, b) => b.count - a.count);
      return { ok: true, sites };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });
}

/** ログイン状態を全部消す。フォルダごと消すのが確実。 */
export function forgetAll() {
  if (!fs.existsSync(PROFILE_DIR)) return { ok: true, removed: false };
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  return { ok: true, removed: true };
}

export { normalizeUrl };
