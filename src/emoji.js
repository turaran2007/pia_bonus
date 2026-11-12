// 対象の絵文字の判定。
// - 標準の絵文字（🪙・:coin:・coin）を設定した場合は名前「coin」で判定し、
//   メッセージに 🪙・:coin:・coin という名前のサーバー独自の絵文字のどれがあっても一致とみなす。
// - サーバー独自の絵文字（<:coin:123>）を設定した場合は、その絵文字（ID が同じもの）だけを一致とみなす。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 異体字セレクタ（U+FE0E / U+FE0F）と肌の色（U+1F3FB〜1F3FF）を取り除く */
export function normalizeEmoji(text) {
  return text.replace(/[\uFE0E\uFE0F]/g, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
}

let table;
function loadTable() {
  if (!table) {
    /** @type {Record<string, string[]>} 絵文字 → 名前の一覧 */
    const byEmoji = require('./emoji-names.json');
    /** @type {Map<string, string>} 名前 → 絵文字 */
    const byName = new Map();
    for (const [emoji, names] of Object.entries(byEmoji)) {
      for (const name of names) if (!byName.has(name)) byName.set(name, emoji);
    }
    table = { byEmoji, byName };
  }
  return table;
}

const CUSTOM_EMOJI = /^<a?:([\w~]+):(\d+)>$/;
const SHORTCODE = /^:([\w+~-]+):$/;

/**
 * 設定値から、判定に使う名前と標準絵文字の組を作る。
 * サーバー独自の絵文字なら customId に ID が入り、その絵文字だけで判定する。
 * @param {string} value  設定に保存されている絵文字
 * @returns {{names: Set<string>, emojis: Set<string>, customId: string | null, label: string} | null}
 */
export function parseEmojiSetting(value) {
  if (!value || !value.trim()) return null;
  const { byEmoji, byName } = loadTable();
  const raw = value.trim();
  const names = new Set();
  const emojis = new Set();

  const custom = CUSTOM_EMOJI.exec(raw);
  if (custom) {
    return { names, emojis, customId: custom[2], label: `:${custom[1]}:` };
  }

  const shortcode = SHORTCODE.exec(raw);
  if (shortcode) {
    names.add(shortcode[1].toLowerCase());
  } else if (byEmoji[normalizeEmoji(raw)]) {
    emojis.add(normalizeEmoji(raw));
  } else if (/^[\w+~-]+$/.test(raw)) {
    // 「coin」のように名前だけが入力された場合
    names.add(raw.toLowerCase());
  } else {
    // 対応表に無い絵文字や文字列は、そのまま含まれているかで判定する
    emojis.add(normalizeEmoji(raw));
  }

  // 名前 ⇔ 標準絵文字 を相互に補う（:coin: → 🪙、🪙 → coin）
  for (const name of [...names]) {
    const emoji = byName.get(name);
    if (emoji) emojis.add(emoji);
  }
  for (const emoji of [...emojis]) {
    for (const name of byEmoji[emoji] ?? []) names.add(name);
  }

  const primary = [...names][0];
  return { names, emojis, customId: null, label: primary ? `:${primary}:` : raw };
}

/** メッセージに対象の絵文字が含まれているか */
export function containsEmoji(content, setting) {
  const target = typeof setting === 'string' ? parseEmojiSetting(setting) : setting;
  if (!target || !content) return false;

  // サーバー独自の絵文字を設定した場合は、その絵文字（ID が同じもの）だけ
  if (target.customId) {
    return [...content.matchAll(/<a?:[\w~]+:(\d+)>/g)].some(match => match[1] === target.customId);
  }

  // サーバー独自の絵文字 <:coin:123> / <a:coin:123>（名前が同じなら一致）
  for (const match of content.matchAll(/<a?:([\w~]+):\d+>/g)) {
    if (target.names.has(match[1].toLowerCase())) return true;
  }
  // 文字のまま書かれた :coin:
  for (const match of content.matchAll(/:([\w+~-]+):/g)) {
    if (target.names.has(match[1].toLowerCase())) return true;
  }
  // 標準の絵文字 🪙
  const normalized = normalizeEmoji(content);
  for (const emoji of target.emojis) {
    if (normalized.includes(emoji)) return true;
  }
  return false;
}
