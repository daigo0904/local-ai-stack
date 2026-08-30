// 会話の保存と読み直し。~/.qwythos-code/sessions/ に置く。
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_DIR } from './config.mjs';
import { withoutHint } from './smalltalk.mjs';

export function newSessionId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function sessionPath(id) {
  return path.join(SESSION_DIR, `${id}.json`);
}

/**
 * 保存する形に整える。
 *
 * 画像は base64 で持っているので、そのまま書き出すと1枚で数MBになる。
 * 会話の記録として残したいのは「画像を見せた」という事実だけなので、
 * 中身は落として名前だけにする。
 */
export function stripImages(data) {
  if (!Array.isArray(data?.messages)) return data;
  return {
    ...data,
    messages: data.messages.map((m) => {
      if (!m.images) return m;
      const { images, ...rest } = m;
      return { ...rest, imageCount: images.length };
    })
  };
}

export function saveSession(id, data) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(sessionPath(id), JSON.stringify(stripImages(data), null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function listSessions(limit = 20) {
  try {
    return fs
      .readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => {
        const full = path.join(SESSION_DIR, f);
        let meta = {};
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
          meta = {
            root: parsed.root,
            model: parsed.model,
            turns: (parsed.messages || []).filter((m) => m.role === 'user').length,
            firstUser: withoutHint((parsed.messages || []).find((m) => m.role === 'user')?.content || '').slice(0, 60)
          };
        } catch {
          /* 壊れたファイルは飛ばす */
        }
        return { id: f.replace(/\.json$/, ''), ...meta };
      });
  } catch {
    return [];
  }
}

export function loadSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function latestSessionForRoot(root) {
  for (const s of listSessions(50)) {
    if (s.root === root) return s.id;
  }
  return null;
}
