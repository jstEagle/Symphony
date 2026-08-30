export type OrderedConversation = {
  id: string;
  pinned: boolean;
};

export type OrderedConversationGroup<T extends OrderedConversation = OrderedConversation> = {
  id: string;
  conversations: readonly T[];
};

/**
 * Applies a user's saved order without making newly-created chats disappear at
 * the end of a group. Missing chats retain the daemon's order and appear before
 * the older, explicitly ordered chats until the user next rearranges the group.
 */
export function orderGroupConversations<T extends OrderedConversation>(
  conversations: readonly T[],
  savedOrder: readonly string[],
): T[] {
  const rank = new Map(uniqueIds(savedOrder).map((id, index) => [id, index]));
  return conversations
    .map((conversation, sourceIndex) => ({ conversation, sourceIndex }))
    .sort((left, right) => {
      const leftRank = rank.get(left.conversation.id);
      const rightRank = rank.get(right.conversation.id);
      if (leftRank === undefined && rightRank === undefined) return left.sourceIndex - right.sourceIndex;
      if (leftRank === undefined) return -1;
      if (rightRank === undefined) return 1;
      return leftRank - rightRank;
    })
    .map(({ conversation }) => conversation);
}

/** Pin order is independent from project/group membership. */
export function orderPinnedConversations<T extends OrderedConversation>(
  conversations: readonly T[],
  savedOrder: readonly string[],
): T[] {
  const rank = new Map(uniqueIds(savedOrder).map((id, index) => [id, index]));
  return conversations
    .map((conversation, sourceIndex) => ({ conversation, sourceIndex }))
    .sort((left, right) => {
      const leftRank = rank.get(left.conversation.id);
      const rightRank = rank.get(right.conversation.id);
      if (leftRank === undefined && rightRank === undefined) return left.sourceIndex - right.sourceIndex;
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    })
    .map(({ conversation }) => conversation);
}

export function currentConversationOrder<T extends OrderedConversation>(
  groups: readonly OrderedConversationGroup<T>[],
  savedOrder: readonly string[],
): string[] {
  return groups.flatMap((group) =>
    orderGroupConversations(group.conversations, savedOrder).map((conversation) => conversation.id),
  );
}

export function moveIdBefore(
  currentOrder: readonly string[],
  movedId: string,
  beforeId?: string,
): string[] {
  const next = uniqueIds(currentOrder).filter((id) => id !== movedId);
  const targetIndex = beforeId ? next.indexOf(beforeId) : -1;
  next.splice(targetIndex >= 0 ? targetIndex : next.length, 0, movedId);
  return next;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim().length > 0))];
}
