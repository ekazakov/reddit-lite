export type VoteValue = -1 | 0 | 1;

/**
 * Same vote again removes it. The opposite vote flips it.
 * `delta` is the change to apply to the cached post score.
 */
export function nextVote(old: VoteValue, clicked: 1 | -1): { next: VoteValue; delta: number } {
  const next: VoteValue = old === clicked ? 0 : clicked;
  return { next, delta: next - old };
}
