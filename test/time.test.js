import { test } from 'node:test';
import assert from 'node:assert/strict';
import moment from 'moment-timezone';
import {
  TIMEZONE, dayName, formatPeriod, isDueToday, monthPeriod, nextSendTime, normalizeDay, parseTime,
  recentPeriod, reportPeriod, toDateString, yearPeriod
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

test('月間・年間の期間', () => {
  const now = jst('2026-03-15 12:00');
  const range = p => [toDateString(p.start), toDateString(p.end)];
  assert.deepEqual(range(monthPeriod(now)), ['2026-03-01', '2026-03-31']);
  assert.deepEqual(range(monthPeriod(now, -1)), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(range(monthPeriod(jst('2026-01-10 00:10'), -1)), ['2025-12-01', '2025-12-31']);
  assert.deepEqual(range(yearPeriod(now)), ['2026-01-01', '2026-12-31']);
  assert.deepEqual(range(yearPeriod(now, -1)), ['2025-01-01', '2025-12-31']);
});

test('送信時刻を過ぎていれば同じ日のうちは送信対象', () => {
  // 2026-11-16 は月曜
  assert.equal(isDueToday(jst('2026-11-16 08:59'), '月曜日', '09:00'), false);
  assert.equal(isDueToday(jst('2026-11-16 09:00'), '月曜日', '09:00'), true);
  assert.equal(isDueToday(jst('2026-11-16 23:59'), '月曜日', '9:00'), true);
  assert.equal(isDueToday(jst('2026-11-17 09:30'), '月曜日', '09:00'), false);
  assert.equal(isDueToday(jst('2026-11-16 10:00'), 'Monday', '09:00'), true);
  assert.equal(isDueToday(jst('2026-11-16 10:00'), null, '09:00'), false);
  assert.equal(isDueToday(jst('2026-11-16 10:00'), '月曜日', null), false);
});
