// メッセージ整形の処理

/**
 * ランキングの行を作る。
 * @param {Array<{userId: string, sent: number, received: number}>} rows
 * @param {'sent'|'received'} key
 * @param {(userId: string) => string} nameOf
 * @param {(entry: {rank: number, name: string, count: number}) => string} formatLine
 */
export function rankingLines(rows, key, nameOf, formatLine) {
  const sorted = rows.filter(row => row[key] > 0).sort((a, b) => b[key] - a[key]);
  // 同じ回数は同じ順位にする（1位、1位、3位…）
  return sorted.map(row => formatLine({
    rank: sorted.findIndex(other => other[key] === row[key]) + 1,
    name: nameOf(row.userId),
    count: row[key]
  }));
}
