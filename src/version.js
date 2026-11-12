// 動いている Bot のバージョン。package.json の番号と、イメージ作成時に埋め込んだコミット ID から作る
import { readFileSync } from 'node:fs';

/** 'v2.1.0 (abc1234)' の形にする。コミット ID が無ければ番号だけ */
export function formatVersion(packageVersion, commit) {
  const sha = /^[0-9a-f]{7,40}$/i.test(commit ?? '') ? commit.slice(0, 7) : null;
  return sha ? `v${packageVersion} (${sha})` : `v${packageVersion}`;
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 例: v2.1.0 (abc1234)。APP_VERSION（コミット ID）は GitHub Actions でのイメージ作成時に入る */
export const VERSION = formatVersion(version, process.env.APP_VERSION);
