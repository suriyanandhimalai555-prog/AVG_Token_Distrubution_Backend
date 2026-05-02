/**
 * On-chain distribution chunking (must stay in sync with scripts/distribute.ts).
 * When the unsent tail is at most SINGLE_TX_REMAINING_THRESHOLD wallets, send
 * them in one multisend tx; otherwise chunk by multiBatchSize (default 50).
 */
export const SINGLE_TX_REMAINING_THRESHOLD = 50;

export function countBatchesForWalletCount(walletCount: number, multiBatchSize: number): number {
  if (walletCount <= 0) return 0;
  let batches = 0;
  let rem = walletCount;
  while (rem > 0) {
    const size = rem <= SINGLE_TX_REMAINING_THRESHOLD ? rem : multiBatchSize;
    rem -= size;
    batches++;
  }
  return batches;
}

export function chunkUnsentBatches<T>(entries: T[], multiBatchSize: number): T[][] {
  const chunks: T[][] = [];
  let i = 0;
  while (i < entries.length) {
    const remaining = entries.length - i;
    const size = remaining <= SINGLE_TX_REMAINING_THRESHOLD ? remaining : multiBatchSize;
    chunks.push(entries.slice(i, i + size));
    i += size;
  }
  return chunks;
}
