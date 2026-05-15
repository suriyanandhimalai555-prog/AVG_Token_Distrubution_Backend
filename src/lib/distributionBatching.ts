/**
 * MultiSender / prepare path: max wallets per single `multisend` transaction.
 * Batch size and parallel worker count are server policy (code), not env — tune
 * `resolveMultiBatchSizeForWalletCount` / `resolveParallelWorkerCountForWalletCount`
 * when you add a dynamic algorithm (e.g. from wallet count).
 */
export const MULTISENDER_MAX_PER_TX = 350;

/** Default wallets per multisend tx (clamped to MULTISENDER_MAX_PER_TX). */
export const DEFAULT_MULTI_BATCH_SIZE = 100;

export const PARALLEL_WORKERS_MIN = 1;
export const PARALLEL_WORKERS_MAX = 10;
/** Default parallel multisend txs in scripts/distribute.ts (clamped 1–10). */
export const DEFAULT_PARALLEL_WORKERS = 5;

function clampMultiBatchSize(n: number): number {
  return Math.min(MULTISENDER_MAX_PER_TX, Math.max(1, Math.floor(n)));
}

function clampParallelWorkers(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PARALLEL_WORKERS;
  return Math.max(PARALLEL_WORKERS_MIN, Math.min(PARALLEL_WORKERS_MAX, Math.floor(n)));
}

/**
 * Wallets per MultiSender tx for a distribution of this size.
 * Today: fixed default; later: derive from totalWallets (and optional signals).
 */
export function resolveMultiBatchSizeForWalletCount(_totalWallets: number): number {
  void _totalWallets;
  return clampMultiBatchSize(DEFAULT_MULTI_BATCH_SIZE);
}

/**
 * Parallel multisend worker count for a distribution of this size.
 * Today: fixed default; later: derive from totalWallets.
 */
export function resolveParallelWorkerCountForWalletCount(_totalWallets: number): number {
  void _totalWallets;
  return clampParallelWorkers(DEFAULT_PARALLEL_WORKERS);
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
