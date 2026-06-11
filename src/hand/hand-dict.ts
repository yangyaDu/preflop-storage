export const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"] as const;

export const HANDS_169 = RANKS.flatMap((leftRank, leftIndex) =>
  RANKS.map((rightRank, rightIndex) => {
    if (leftIndex === rightIndex) return `${leftRank}${rightRank}`;
    if (leftIndex < rightIndex) return `${leftRank}${rightRank}s`;
    return `${rightRank}${leftRank}o`;
  }),
);

if (HANDS_169.length !== 169) {
  throw new Error(`Invalid hand dictionary length: ${HANDS_169.length}`);
}

export const HAND_ID_BY_CODE = new Map(HANDS_169.map((hand, index) => [hand, index]));

export function getHandId(holeCards: string): number {
  const handId = HAND_ID_BY_CODE.get(holeCards);
  if (handId === undefined) throw new Error(`Unknown hole cards: ${holeCards}`);
  return handId;
}

export function getHandCode(handId: number): string {
  const handCode = HANDS_169[handId];
  if (handCode === undefined) throw new Error(`Unknown hand id: ${handId}`);
  return handCode;
}
