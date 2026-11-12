// メッセージから「誰に記録するか」を決める処理

/**
 * 除外チャンネルに当たるか。
 * チャンネル自身・親（スレッドならその親チャンネル、通常のチャンネルならカテゴリー）・
 * スレッドの親チャンネルのカテゴリーのどれかが除外リストにあれば除外する。
 */
export function isExcludedChannel(channel, excludedIds) {
  if (!channel || !excludedIds || excludedIds.length === 0) return false;
  const ids = [channel.id, channel.parentId, channel.parent?.parentId].filter(Boolean);
  return ids.some(id => excludedIds.includes(id));
}

/**
 * 記録対象のユーザー ID を集める（Bot と送った本人は除く）。
 * @param {object} p
 * @param {string} p.senderId
 * @param {string} p.botUserId
 * @param {Iterable<{id: string, bot: boolean}>} p.users          直接メンションされたユーザー
 * @param {Iterable<Iterable<{id: string, user: {bot: boolean}}>>} p.roleMembers  メンションされたロールごとのメンバー
 * @param {boolean} p.everyone                                    @everyone / @here が含まれるか
 * @param {Iterable<{id: string, user: {bot: boolean}}>} p.allMembers  サーバーの全メンバー
 * @param {{countRoles: boolean, countEveryone: boolean}} p.options
 */
export function collectReceivers({ senderId, botUserId, users, roleMembers, everyone, allMembers, options }) {
  const receivers = new Set();
  const add = (id, isBot) => {
    if (!isBot && id !== senderId && id !== botUserId) receivers.add(id);
  };

  for (const user of users) add(user.id, user.bot);
  if (options.countRoles) {
    for (const members of roleMembers) {
      for (const member of members) add(member.id, member.user.bot);
    }
  }
  if (options.countEveryone && everyone) {
    for (const member of allMembers) add(member.id, member.user.bot);
  }
  return [...receivers];
}
