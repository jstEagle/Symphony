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

/**
 * Describes a command-palette entry without coupling the ranking layer to
 * React or an icon library. The caller owns availability and execution; this
 * helper only decides which available entries match the user's query.
 */
export type PaletteSearchAction = Readonly<{
  id: string;
  label: string;
  detail?: string;
  keywords?: readonly string[];
  available?: boolean;
}>;

export function actionSearchText(action: PaletteSearchAction): string {
  return [action.id, action.label, action.detail, ...(action.keywords ?? [])].filter(Boolean).join(" ");
}

/**
 * Keep command ranking deterministic and fuzzy. Unavailable actions never
 * become executable results, which is important for daemon permission gates.
 */
export function rankPaletteActions<T extends PaletteSearchAction>(
  actions: readonly T[],
  query: string,
  limit = 48,
): T[] {
  return rankFuzzyMatches(
    actions.filter((action) => action.available !== false),
    query,
    actionSearchText,
    limit,
  );
}
