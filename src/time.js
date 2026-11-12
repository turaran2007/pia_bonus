// 日付・時刻まわりの処理。すべて日本時間（Asia/Tokyo）で扱う。
import moment from 'moment-timezone';

export const TIMEZONE = 'Asia/Tokyo';

export const DAYS = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

// 旧バージョン（deploy-commands.js の /pia_setday）で保存された英語の曜日にも対応する
const ENGLISH_DAYS = {
  Sunday: '日曜日',
  Monday: '月曜日',
  Tuesday: '火曜日',
  Wednesday: '水曜日',
  Thursday: '木曜日',
  Friday: '金曜日',
  Saturday: '土曜日'
};

export function nowJst() {
  return moment().tz(TIMEZONE);
}

/** moment を日本時間の 'YYYY-MM-DD' にする */
export function toDateString(m) {
  return m.clone().tz(TIMEZONE).format('YYYY-MM-DD');
}

export function dayName(m) {
  return DAYS[m.clone().tz(TIMEZONE).day()];
}

/** 保存されている曜日を '月曜日' 形式にそろえる。不明なら null */
export function normalizeDay(value) {
  if (!value) return null;
  if (DAYS.includes(value)) return value;
  return ENGLISH_DAYS[value] ?? null;
}

/**
 * 入力された時刻を 'HH:mm' にそろえる。
 * '9:00' '09:00' '９：００'（全角）などを受け付け、不正なら null。
 */
export function parseTime(input) {
  if (typeof input !== 'string') return null;
  const halfWidth = input
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':');
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(halfWidth);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 定期投稿の集計期間：送信日の前日までの 7 日間（両端を含む）。
 * 送信日当日の記録は次回の集計に入るので、取りこぼしも重複もない。
 */
export function reportPeriod(now) {
  const end = now.clone().tz(TIMEZONE).startOf('day').subtract(1, 'day');
  const start = end.clone().subtract(6, 'days');
  return { start, end };
}

/** /pia_weekly の集計期間：今日を含む直近 7 日間（両端を含む） */
export function recentPeriod(now) {
  const end = now.clone().tz(TIMEZONE).startOf('day');
  const start = end.clone().subtract(6, 'days');
  return { start, end };
}

/** 'M月D日～M月D日' 形式 */
export function formatPeriod({ start, end }) {
  return `${start.format('M月D日')}～${end.format('M月D日')}`;
}

/** 次に定期投稿される日時（now より後）。設定が不完全なら null */
export function nextSendTime(now, day, time) {
  const dayIndex = DAYS.indexOf(normalizeDay(day));
  const normalizedTime = parseTime(time ?? '');
  if (dayIndex < 0 || !normalizedTime) return null;
  const [hour, minute] = normalizedTime.split(':').map(Number);
  const base = now.clone().tz(TIMEZONE);
  const candidate = base.clone().day(dayIndex).hour(hour).minute(minute).second(0).millisecond(0);
  while (!candidate.isAfter(base)) candidate.add(7, 'days');
  return candidate;
}
