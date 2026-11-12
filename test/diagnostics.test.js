import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { DEFAULT_SETTINGS } from '../src/db.js';
import { describeDiscordError, diagnose } from '../src/diagnostics.js';
import { checkView } from '../src/views.js';

const perms = (...flags) => new PermissionsBitField(flags);
const ALL_RECORD = perms(P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.SendMessagesInThreads);
const ALL_REPORT = perms(P.ViewChannel, P.SendMessages, P.CreatePublicThreads, P.SendMessagesInThreads);
const settings = { ...DEFAULT_SETTINGS, guildId: 'g', emoji: '🪙', channelId: 'c' };

const errors = results => results.filter(r => r.level === 'error').map(r => r.text);

test('問題がなければエラーなし', () => {
  const results = diagnose({
    settings, excluded: false, channelPermissions: ALL_RECORD, isThread: false,
    reportChannel: { found: true, permissions: ALL_REPORT }
  });
  assert.deepEqual(errors(results), []);
});

test('チャンネルを見られないと記録されない', () => {
  const results = diagnose({
    settings, excluded: false, channelPermissions: perms(P.SendMessages, P.ReadMessageHistory), isThread: false,
    reportChannel: { found: true, permissions: ALL_REPORT }
  });
  assert.equal(errors(results).length, 1);
  assert.match(errors(results)[0], /チャンネルを見る.*記録されません/);
});

test('返信に必要な権限が無い', () => {
  const results = diagnose({
    settings, excluded: false, channelPermissions: perms(P.ViewChannel), isThread: false,
    reportChannel: { found: true, permissions: ALL_REPORT }
  });
  assert.equal(errors(results).length, 2);
  assert.ok(errors(results).every(t => t.includes('返信ができません')));
});

test('スレッドでは「スレッドでメッセージを送信」を見る', () => {
  const inThread = perms(P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads);
  const results = diagnose({
    settings, excluded: false, channelPermissions: inThread, isThread: true,
    reportChannel: { found: true, permissions: ALL_REPORT }
  });
  assert.deepEqual(errors(results), []);
});

test('絵文字未設定・除外チャンネル・投稿先の問題', () => {
  const results = diagnose({
    settings: { ...settings, emoji: null }, excluded: true, channelPermissions: ALL_RECORD, isThread: false,
    reportChannel: { found: true, permissions: perms(P.ViewChannel, P.SendMessages) }
  });
  const e = errors(results);
  assert.equal(e.length, 3);
  assert.ok(e.some(t => t.includes('絵文字が設定されていません')));
  assert.ok(e.some(t => t.includes('除外チャンネル')));
  assert.ok(e.some(t => t.includes('「公開スレッドの作成」「スレッドでメッセージを送信」')));

  const notFound = diagnose({ settings, excluded: false, channelPermissions: ALL_RECORD, isThread: false, reportChannel: { found: false } });
  assert.ok(errors(notFound).some(t => t.includes('見つからない')));

  const unset = diagnose({ settings, excluded: false, channelPermissions: ALL_RECORD, isThread: false, reportChannel: null });
  assert.ok(unset.some(r => r.level === 'warning'));
});

test('Discord のエラーコードの説明', () => {
  assert.match(describeDiscordError({ code: 50013 }), /権限が足りません/);
  assert.match(describeDiscordError({ code: 160002 }), /メッセージ履歴/);
  assert.equal(describeDiscordError(new Error('x')), null);
});

test('診断結果の画面', () => {
  const results = diagnose({ settings, excluded: false, channelPermissions: perms(), isThread: false, reportChannel: null });
  const json = JSON.stringify(checkView(results).map(c => c.toJSON()));
  assert.ok(json.includes('件の問題があります'));
});
