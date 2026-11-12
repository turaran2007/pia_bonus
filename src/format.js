// メッセージ整形の処理

export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Discord の文字数制限に収まるよう、行単位で分割する。
 * 1 行だけで制限を超える場合は、その行を途中で切る。
 */
export function splitMessage(text, maxLength = DISCORD_MESSAGE_LIMIT) {
  const chunks = [];
  let current = '';

  const push = () => {
    if (current.trim().length > 0) chunks.push(current.replace(/\n+$/, ''));
    current = '';
  };

  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    while (line.length > maxLength) {
      push();
      chunks.push(line.slice(0, maxLength));
      line = line.slice(maxLength);
    }
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (next.length > maxLength) {
      push();
      current = line;
    } else {
      current = next;
    }
  }
  push();
  return chunks;
}

/**
 * ランキングの行を作る。
 * @param {Array<{userId: string, sent: number, received: number}>} rows
 * @param {'sent'|'received'} key
 * @param {(userId: string) => string} nameOf
 * @param {(entry: {rank: number, name: string, count: number}) => string} formatLine
 */
export function rankingLines(rows, key, nameOf, formatLine) {
  return rows
    .filter(row => row[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .map((row, index) => formatLine({ rank: index + 1, name: nameOf(row.userId), count: row[key] }));
}
