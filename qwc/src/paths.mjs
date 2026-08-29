// 作業フォルダの外へ出ないようにするための道具。
import path from 'node:path';
import fs from 'node:fs';

export class PathError extends Error {}

export function resolveSafe(inputPath, ctx) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new PathError('path が指定されていません。');
  }
  const expanded = inputPath.startsWith('~')
    ? path.join(process.env.HOME || '', inputPath.slice(1))
    : inputPath;
  const abs = path.resolve(ctx.root, expanded);

  if (!ctx.config.allowOutsideRoot) {
    const rel = path.relative(ctx.root, abs);
    const outside = rel.startsWith('..') || path.isAbsolute(rel);
    if (outside) {
      throw new PathError(
        `作業フォルダ (${ctx.root}) の外は触れません: ${inputPath}\n` +
        '外を触る必要があるなら、そのフォルダで qwc を起動し直してください。'
      );
    }
  }
  return abs;
}

export function displayPath(abs, ctx) {
  const rel = path.relative(ctx.root, abs);
  if (!rel) return '.';
  return rel.startsWith('..') ? abs : rel;
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.venv', 'venv',
  '__pycache__', '.cache', '.turbo', 'target', '.DS_Store', 'vendor',
  '.pytest_cache', '.mypy_cache', 'coverage', '.gradle', 'Pods'
]);

export function isIgnored(name) {
  return IGNORED_DIRS.has(name);
}

export function isProbablyBinary(buffer) {
  const len = Math.min(buffer.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
