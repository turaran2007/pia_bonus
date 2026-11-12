import { test } from 'node:test';
import assert from 'node:assert/strict';
import moment from 'moment-timezone';
import {
  TIMEZONE, dayName, formatPeriod, nextSendTime, normalizeDay, parseTime,
  recentPeriod, reportPeriod, toDateString
} from '../src/time.js';

const jst = s => moment.tz(s, TIMEZONE);

test('日本時間の 0〜9 時も当日の日付になる', () => {
  // UTC では前日の 2026-11-11T15:30Z
  const m = jst('2026-11-12 00:30');
  assert.equal(toDateString(m), '2026-11-12');
  assert.equal(toDateString(moment.utc('2026-11-11T15:30:00Z')), '2026-11-12');
});

test('定期投稿の集計期間は前日までの7日間', () => {
  const period = reportPeriod(jst('2026-11-16 09:00')); // 月曜
  assert.equal(toDateString(period.start), '2026-11-09');
  assert.equal(toDateString(period.end), '2026-11-15');
  assert.equal(formatPeriod(period), '11月9日～11月15日');
  // 翌週の期間と重ならず、隙間もない
  const next = reportPeriod(jst('2026-11-23 09:00'));
  assert.equal(toDateString(next.start), '2026-11-16');
});

test('/pia_weekly の期間は今日を含む7日間', () => {
  const period = recentPeriod(jst('2026-11-12 23:59'));
  assert.equal(toDateString(period.start), '2026-11-06');
  assert.equal(toDateString(period.end), '2026-11-12');
});

test('時刻の入力をそろえる', () => {
  assert.equal(parseTime('9:00'), '09:00');
  assert.equal(parseTime(' 09:05 '), '09:05');
  assert.equal(parseTime('９：３０'), '09:30');
  assert.equal(parseTime('23:59'), '23:59');
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('9:60'), null);
  assert.equal(parseTime('900'), null);
  assert.equal(parseTime(''), null);
});

test('曜日', () => {
  assert.equal(dayName(jst('2026-11-12 12:00')), '木曜日');
  assert.equal(normalizeDay('Monday'), '月曜日');
  assert.equal(normalizeDay('月曜日'), '月曜日');
  assert.equal(normalizeDay('foo'), null);
  assert.equal(normalizeDay(null), null);
});

test('次回の投稿日時', () => {
  const now = jst('2026-11-12 10:00'); // 木曜
  assert.equal(nextSendTime(now, '木曜日', '09:00').format('YYYY-MM-DD HH:mm'), '2026-11-19 09:00');
  assert.equal(nextSendTime(now, '木曜日', '11:00').format('YYYY-MM-DD HH:mm'), '2026-11-12 11:00');
  assert.equal(nextSendTime(now, '月曜日', '9:00').format('YYYY-MM-DD HH:mm'), '2026-11-16 09:00');
  assert.equal(nextSendTime(now, null, '09:00'), null);
});
