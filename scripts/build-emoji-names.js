// 標準絵文字の「名前 ⇔ 絵文字」の対応表（src/emoji-names.json）を作る。
// Discord の絵文字名（:coin: など）は GitHub / Slack(iamcal) 系の名前とほぼ同じなので、
// emojibase-data の GitHub と Slack(iamcal) の名前セットを使う。
//
// 使い方（絵文字データを更新するときだけ）:
//   npm run build:emoji
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { normalizeEmoji } from '../src/emoji.js';

const require = createRequire(import.meta.url);
const SETS = ['github', 'iamcal'];

const emojis = require('emojibase-data/en/compact.json');
const shortcodes = SETS.map(set => require(`emojibase-data/en/shortcodes/${set}.json`));

// { "🪙": ["coin"], "👍": ["+1", "thumbsup", ...] }（絵文字は異体字セレクタを除いた形）
const names = {};
for (const emoji of emojis) {
  const list = new Set();
  for (const set of shortcodes) {
    const value = set[emoji.hexcode];
    for (const name of [value].flat()) if (name) list.add(name.toLowerCase());
  }
  if (list.size > 0) names[normalizeEmoji(emoji.unicode)] = [...list];
}

const out = new URL('../src/emoji-names.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(names)}\n`);
const { version } = JSON.parse(readFileSync(require.resolve('emojibase-data/package.json'), 'utf8'));
console.log(`✅ ${Object.keys(names).length} 個の絵文字の名前を書き出しました（emojibase-data ${version}）`);
