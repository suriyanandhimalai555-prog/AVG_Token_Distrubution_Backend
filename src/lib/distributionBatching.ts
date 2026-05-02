/**
 * Fixed-size on-chain multisend batches (must stay in sync with scripts/distribute.ts).
 * Default 100 wallets per tx; override with BATCH_SIZE env (capped by contract max).
 */
export const MULTISENDER_MAX_PER_TX = 350;

export function resolveMultiBatchSizeFromEnv(): number {
  const raw = Number(process.env.BATCH_SIZE ?? 100);
  return Math.min(MULTISENDER_MAX_PER_TX, Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 100)));
}

export function countBatchesForWalletCount(walletCount: number, multiBatchSize: number): number {
  if (walletCount <= 0) return 0;
  const size = Math.min(MULTISENDER_MAX_PER_TX, Math.max(1, multiBatchSize));
  return Math.ceil(walletCount / size);
}

export function chunkFixedBatches<T>(entries: T[], multiBatchSize: number): T[][] {
  const size = Math.min(MULTISENDER_MAX_PER_TX, Math.max(1, multiBatchSize));
  const chunks: T[][] = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(entries.slice(i, i + size));
  }
  return chunks;
}
