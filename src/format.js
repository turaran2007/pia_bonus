// メッセージ整形の処理

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
