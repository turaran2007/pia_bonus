// 設定の変更やリセットができるかどうかの判定
import { PermissionFlagsBits } from 'discord.js';

/** 'id1, id2' のような文字列から Discord のユーザー ID を取り出す */
export function parseUserIds(value) {
  return (value ?? '')
    .split(/[\s,]+/)
    .filter(id => /^\d{17,20}$/.test(id));
}

/**
 * Bot のアプリケーションの所有者（個人、またはチームのメンバー）の ID。
 * @param {{owner?: {id: string, members?: Map<string, {id: string}>}}} application
 */
export function applicationOwnerIds(application) {
  const owner = application?.owner;
  if (!owner) return [];
  if (owner.members) return [...owner.members.values()].map(member => member.id);
  return [owner.id];
}

/**
 * サーバーの管理者、または Bot の管理者（ownerIds）なら true。
 * Bot の管理者は、どのサーバーでも設定の変更とリセットができる。
 */
export function canManage({ userId, memberPermissions }, ownerIds) {
  if (ownerIds.has(userId)) return true;
  return memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}
