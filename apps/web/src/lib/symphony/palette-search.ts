export function fuzzyScore(query: string, value: string): number {
  const normalized = query.trim().toLocaleLowerCase();
  const haystack = value.toLocaleLowerCase();
  if (!normalized) return 1;
  if (haystack.includes(normalized)) return 1_000 - haystack.indexOf(normalized);

  let cursor = 0;
  let score = 0;
  for (const character of normalized) {
    const index = haystack.indexOf(character, cursor);
    if (index < 0) return 0;
    score += Math.max(1, 12 - (index - cursor));
    cursor = index + 1;
  }
  return score;
}

export function rankFuzzyMatches<T>(
  items: readonly T[],
  query: string,
  searchableText: (item: T) => string,
  limit = 24,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  return items
    .map((item, sourceIndex) => ({ item, sourceIndex, score: fuzzyScore(normalized, searchableText(item)) }))
    .filter((entry) => !normalized || entry.score > 0)
    .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)
    .slice(0, limit)
    .map(({ item }) => item);
}
