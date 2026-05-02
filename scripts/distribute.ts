import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { ethers, JsonRpcProvider, Wallet, Contract, TransactionResponse, TransactionReceipt } from "ethers";
import { chunkUnsentBatches, countBatchesForWalletCount } from "../src/lib/distributionBatching";

dotenv.config();

// ─── Paths ────────────────────────────────────────────────────────────────────

const OUTPUT_DIR    = path.resolve(__dirname, "../output");
const PLAN_FILE     = path.join(OUTPUT_DIR, "distribution-plan.json");
const LOG_FILE      = path.join(OUTPUT_DIR, "distribution.log");
const CSV_LOG_FILE  = path.join(OUTPUT_DIR, "distribution-log.csv");
const ARTIFACTS_DIR = path.resolve(__dirname, "../artifacts/contracts");

// ─── Config ───────────────────────────────────────────────────────────────────

const BATCH_SIZE       = Math.max(20, Math.min(500, Number(process.env.BATCH_SIZE ?? 50)));
const PARALLEL_BATCHES = Math.max(1, Math.min(10, Number(process.env.PARALLEL_BATCHES ?? 1)));
const MAX_RETRIES      = 3;
const RETRY_DELAYS_MS  = [5_000, 10_000, 15_000];
const MAX_DRAIN_PASSES = 5;

// 50 cold ERC20 transfers via transfer() ≈ 3.25M gas; 4M gives ~23% headroom.
const GAS_LIMIT    = 4_000_000n;
const GAS_PRICE    = ethers.parseUnits("3", "gwei");
const CONFIRMATIONS = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DistributionEntry {
  index: number;
  address: string;
  amount: number;
  amountWei: string;
  packedHex: string;
  sent: boolean;
  txHash: string | null;
  timestamp: string | null;
}

interface BatchResult {
  batchIndex: number;
  success: boolean;
  txHash?: string;
  gasUsed?: bigint;
  error?: string;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logStream.write(line + "\n");
}

function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  const line = `[${new Date().toISOString()}] ERROR: ${message}${detail ? " — " + detail : ""}`;
  console.error(line);
  logStream.write(line + "\n");
}

// ─── Duration Formatter ───────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${m}m ${s}s`;
}

// ─── RPC Manager ──────────────────────────────────────────────────────────────

class RpcManager {
  private readonly _primary:   JsonRpcProvider;
  private readonly _fallback1: JsonRpcProvider;
  private readonly _fallback2: JsonRpcProvider;

  constructor() {
    this._primary   = new JsonRpcProvider(requireEnv("ALCHEMY_RPC_URL"));
    this._fallback1 = new JsonRpcProvider(requireEnv("FALLBACK_RPC_1"));
    this._fallback2 = new JsonRpcProvider(requireEnv("FALLBACK_RPC_2"));
  }

  getPrimary(): JsonRpcProvider { return this._primary; }

  async broadcast(signedTx: string): Promise<TransactionResponse> {
    const providers = [
      { name: "Alchemy (primary)",   provider: this._primary   },
      { name: "Binance Fallback 1",  provider: this._fallback1 },
      { name: "Binance Fallback 2",  provider: this._fallback2 },
    ];

    let lastError: unknown;

    for (const { name, provider } of providers) {
      try {
        const tx = await provider.broadcastTransaction(signedTx);
        log(`  Broadcast via ${name}`);
        return tx;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit =
          msg.includes("429") ||
          msg.includes("SERVER_ERROR") ||
          msg.includes("TIMEOUT") ||
          msg.includes("timeout") ||
          msg.includes("rate limit");

        if (isRateLimit) {
          log(`  ${name} rate-limited — trying next provider...`);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw new Error(`All RPC providers exhausted. Last error: ${String(lastError)}`);
  }
}

// ─── Serial TX Submitter ─────────────────────────────────────────────────────
//
// Serialises nonce assignment + broadcast across parallel batches.
// Each broadcastSerial() call chains onto the internal queue so nonces are
// assigned one-at-a-time: sign1→broadcast1 → sign2→broadcast2 → …
// After broadcast the caller waits for receipt in parallel, giving full
// throughput while keeping nonces collision-free.

class SerialTxSubmitter {
  private queue: Promise<number>;

  constructor(private deployer: Wallet, private rpcManager: RpcManager) {
    // Seed the queue with the current pending nonce
    this.queue = rpcManager.getPrimary()
      .getTransactionCount(deployer.address, "pending");
  }

  broadcastSerial(buildSignedTx: (nonce: number) => Promise<string>): Promise<TransactionResponse> {
    return new Promise<TransactionResponse>((resolve, reject) => {
      // Append to the queue — runs after all previous entries finish
      this.queue = this.queue.then(async (nonce) => {
        try {
          const signed = await buildSignedTx(nonce);
          const tx = await this.rpcManager.broadcast(signed);
          resolve(tx);
          return nonce + 1;
        } catch (err) {
          reject(err);
          // Re-fetch nonce on error — we don't know if it was consumed
          return this.rpcManager.getPrimary()
            .getTransactionCount(this.deployer.address, "pending");
        }
      });
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function loadPlan(): DistributionEntry[] {
  if (!fs.existsSync(PLAN_FILE)) {
    throw new Error(`distribution-plan.json not found. Run prepare-distribution.ts first.`);
  }
  return JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")) as DistributionEntry[];
}

function savePlan(plan: DistributionEntry[]): void {
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");
}

function loadAbi(contractName: string, solFile: string): ethers.InterfaceAbi {
  const p = path.join(ARTIFACTS_DIR, solFile, `${contractName}.json`);
  if (!fs.existsSync(p)) throw new Error(`Artifact not found: ${p}. Run npx hardhat compile first.`);
  return (JSON.parse(fs.readFileSync(p, "utf8")) as { abi: ethers.InterfaceAbi }).abi;
}

// ─── Fund MultiSender ─────────────────────────────────────────────────────────
//
// Instead of approve() + transferFrom(), we pre-load tokens INTO the MultiSender
// contract. MultiSender then calls transfer() directly — skipping the allowance
// SSTORE that transferFrom() requires (~5,000 gas saved per wallet = ~5 BNB total).

async function ensureFunded(
  tokenAddress: string,
  multisenderAddress: string,
  deployer: Wallet,
  unsentEntries: DistributionEntry[]
): Promise<void> {
  const provider = deployer.provider;
  if (!provider) {
    throw new Error("Deployer wallet has no provider.");
  }

  // Fail fast with a clear message when address/network mismatch happens.
  const [tokenCode, multisenderCode] = await Promise.all([
    provider.getCode(tokenAddress),
    provider.getCode(multisenderAddress),
  ]);
  if (!tokenCode || tokenCode === "0x") {
    throw new Error(
      `TOKEN_ADDRESS is not a contract on the currently selected network: ${tokenAddress}. ` +
      "Use a token deployed on this network (or switch network)."
    );
  }
  if (!multisenderCode || multisenderCode === "0x") {
    throw new Error(
      `MULTISENDER_ADDRESS is not a contract on the currently selected network: ${multisenderAddress}. ` +
      "Deploy MultiSender on this network first."
    );
  }

  const token = new Contract(tokenAddress, loadAbi("ABCToken", "ABCToken.sol"), deployer);

  const totalNeeded: bigint = unsentEntries.reduce(
    (acc, e) => acc + BigInt(e.amountWei), 0n
  );

  log(`Tokens needed for remaining wallets: ${ethers.formatEther(totalNeeded)}`);

  const msBalance = await token.balanceOf(multisenderAddress) as bigint;
  log(`MultiSender token balance: ${ethers.formatEther(msBalance)}`);

  if (msBalance < totalNeeded) {
    const topUp = totalNeeded - msBalance;
    log(`Sending ${ethers.formatEther(topUp)} → MultiSender...`);
    const tx = await token.transfer(multisenderAddress, topUp) as TransactionResponse;
    log(`  Fund TX: ${tx.hash}`);
    await tx.wait(1);
    log(`  Done. MultiSender funded.`);
  } else {
    log("MultiSender already holds sufficient tokens — skipping fund transfer.");
  }
}

// ─── Batch Sender ─────────────────────────────────────────────────────────────

async function sendBatch(
  batch: DistributionEntry[],
  batchIndex: number,
  totalBatches: number,
  multisender: Contract,
  tokenAddress: string,
  multisenderAddress: string,
  deployer: Wallet,
  rpcManager: RpcManager,
  submitter: SerialTxSubmitter,
  chainId: bigint
): Promise<TransactionReceipt> {
  const indices  = batch.map((w) => w.index);
  const packed   = batch.map((w) => w.packedHex);

  const tx = await submitter.broadcastSerial(async (nonce) => {
    const calldata = multisender.interface.encodeFunctionData("multisend", [
      tokenAddress, indices, packed,
    ]);
    return deployer.signTransaction({
      to:       multisenderAddress,
      data:     calldata,
      gasLimit: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      nonce,
      chainId,
      value:    0n,
    });
  });

  const receipt = await tx.wait(CONFIRMATIONS);
  if (!receipt) throw new Error("Transaction receipt is null");

  log(
    `Batch ${batchIndex}/${totalBatches} | Wallets: ${batch.length} | TX: ${receipt.hash} | Gas: ${receipt.gasUsed.toLocaleString()} | CONFIRMED`
  );

  return receipt;
}

async function sendBatchWithRetry(
  batch: DistributionEntry[],
  batchIndex: number,
  totalBatches: number,
  multisender: Contract,
  tokenAddress: string,
  multisenderAddress: string,
  deployer: Wallet,
  rpcManager: RpcManager,
  submitter: SerialTxSubmitter,
  chainId: bigint
): Promise<BatchResult> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const receipt = await sendBatch(
        batch, batchIndex, totalBatches,
        multisender, tokenAddress, multisenderAddress,
        deployer, rpcManager, submitter, chainId
      );
      return { batchIndex, success: true, txHash: receipt.hash, gasUsed: receipt.gasUsed };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        logError(`Batch ${batchIndex} attempt ${attempt}/${MAX_RETRIES} failed: ${message}. Retrying in ${delay / 1000}s...`);
        await sleep(delay);
      } else {
        const delay = RETRY_DELAYS_MS[MAX_RETRIES - 1];
        logError(`Batch ${batchIndex} attempt ${attempt}/${MAX_RETRIES} failed: ${message}. Waiting ${delay / 1000}s then marking FAILED.`);
        await sleep(delay);
        return { batchIndex, success: false, error: message };
      }
    }
  }
  return { batchIndex, success: false, error: "Max retries exceeded" };
}

// ─── CSV Log Writer ───────────────────────────────────────────────────────────

function writeCsvLog(plan: DistributionEntry[]): void {
  const sent = plan.filter((e) => e.sent);
  const lines = ["index,address,amount,amountWei,txHash,timestamp"];
  for (const e of sent) {
    lines.push(`${e.index},${e.address},${e.amount},${e.amountWei},${e.txHash ?? ""},${e.timestamp ?? ""}`);
  }
  fs.writeFileSync(CSV_LOG_FILE, lines.join("\n"), "utf8");
  log(`distribution-log.csv written — ${sent.length.toLocaleString()} entries.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  log("═══════════════════════════════════════════════════════════");
  log("BNB Token Distribution — Starting (Optimized v2)");
  log("═══════════════════════════════════════════════════════════");

  const tokenAddress       = requireEnv("TOKEN_ADDRESS");
  const multisenderAddress = requireEnv("MULTISENDER_ADDRESS");
  const privateKey         = requireEnv("PRIVATE_KEY");

  const rpcManager      = new RpcManager();
  const primaryProvider = rpcManager.getPrimary();
  const deployer        = new Wallet(
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
    primaryProvider
  );

  log(`Deployer:    ${deployer.address}`);
  const bnbBefore = await primaryProvider.getBalance(deployer.address);
  log(`BNB balance: ${ethers.formatEther(bnbBefore)} BNB`);

  const network  = await primaryProvider.getNetwork();
  const chainId  = network.chainId;

  const multisenderAbi = loadAbi("MultiSender", "MultiSender.sol");
  const multisender    = new Contract(multisenderAddress, multisenderAbi, deployer);

  const plan       = loadPlan();
  const totalStart = plan.filter((e) => !e.sent).length;

  log(`Total wallets in plan: ${plan.length.toLocaleString()}`);
  log(`Already sent:          ${(plan.length - totalStart).toLocaleString()}`);
  log(`Remaining:             ${totalStart.toLocaleString()}`);

  if (totalStart === 0) {
    log("All wallets already sent!");
    writeCsvLog(plan);
    process.exit(0);
  }

  // Fund MultiSender with tokens (instead of approve — saves ~5 BNB in gas)
  await ensureFunded(tokenAddress, multisenderAddress, deployer, plan.filter((e) => !e.sent));

  const startTime = Date.now();
  const totalBatches = countBatchesForWalletCount(totalStart, BATCH_SIZE);

  // ── Drain loop: repeat until all wallets sent or no progress made ──────────
  for (let pass = 1; pass <= MAX_DRAIN_PASSES; pass++) {
    const unsent = plan.filter((e) => !e.sent);
    if (unsent.length === 0) break;

    log(`\n${"─".repeat(60)}`);
    log(`Pass ${pass}/${MAX_DRAIN_PASSES} — ${unsent.length.toLocaleString()} wallets remaining`);
    log(`${"─".repeat(60)}`);

    const batches        = chunkUnsentBatches(unsent, BATCH_SIZE);
    const parallelGroups = chunkArray(batches, PARALLEL_BATCHES);

    // Fresh submitter each pass = fresh nonce chain
    const submitter = new SerialTxSubmitter(deployer, rpcManager);

    const sentWalletCount = plan.length - unsent.length;
    let batchOrdinal = countBatchesForWalletCount(sentWalletCount, BATCH_SIZE);
    let passSuccess    = 0;
    let passFail       = 0;

    for (let groupIdx = 0; groupIdx < parallelGroups.length; groupIdx++) {
      const group = parallelGroups[groupIdx];

      // Fire all batches in the group; SerialTxSubmitter serialises sign+broadcast
      const batchPromises = group.map((batch) => {
        batchOrdinal++;
        return sendBatchWithRetry(
          batch, batchOrdinal, totalBatches,
          multisender, tokenAddress, multisenderAddress,
          deployer, rpcManager, submitter, chainId
        );
      });

      const results = await Promise.allSettled(batchPromises);

      let batchOffset = 0;
      for (const settled of results) {
        const currentBatch = group[batchOffset++];

        if (settled.status === "fulfilled" && settled.value.success) {
          for (const entry of currentBatch) {
            const p = plan.find((x) => x.index === entry.index);
            if (p) { p.sent = true; p.txHash = settled.value.txHash ?? null; p.timestamp = new Date().toISOString(); }
          }
          passSuccess += currentBatch.length;
        } else {
          const reason = settled.status === "rejected"
            ? String(settled.reason)
            : settled.value.error ?? "unknown";
          logError(`Batch failed permanently: ${reason}`);
          passFail += currentBatch.length;
        }
      }

      savePlan(plan);
      log(`Group ${groupIdx + 1}/${parallelGroups.length} | ✓ ${passSuccess.toLocaleString()} sent | ✗ ${passFail.toLocaleString()} failed | Checkpoint saved`);
    }

    const stillUnsent = plan.filter((e) => !e.sent).length;
    log(`\nPass ${pass} done. Sent: ${passSuccess.toLocaleString()} | Failed: ${passFail.toLocaleString()} | Remaining: ${stillUnsent.toLocaleString()}`);

    if (stillUnsent === unsent.length) {
      logError("No progress made this pass — stopping drain loop.");
      break;
    }
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  const elapsed    = (Date.now() - startTime) / 1000;
  const bnbAfter   = await primaryProvider.getBalance(deployer.address);
  const bnbUsed    = ethers.formatEther(bnbBefore - bnbAfter);
  const finalSent  = plan.filter((e) => e.sent).length;
  const finalFail  = plan.filter((e) => !e.sent).length;

  log("\n═══════════════════════════════════════════════════════════");
  log("DISTRIBUTION COMPLETE");
  log("═══════════════════════════════════════════════════════════");
  log(`Total time:        ${formatDuration(elapsed)}`);
  log(`Wallets sent:      ${finalSent.toLocaleString()} / ${plan.length.toLocaleString()}`);
  log(`Wallets failed:    ${finalFail.toLocaleString()}`);
  log(`BNB spent:         ${bnbUsed} BNB`);
  log(`Throughput:        ${(finalSent / elapsed).toFixed(1)} wallets/s`);
  log("═══════════════════════════════════════════════════════════");

  writeCsvLog(plan);
  logStream.end();
}

// ─── SIGINT Handler ───────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  const msg = `[${new Date().toISOString()}] Interrupted. State saved. Re-run to resume.`;
  console.log("\n" + msg);
  logStream.write(msg + "\n");
  logStream.end();
  process.exit(0);
});

// ─── Entry Point ──────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  logError("Fatal error:", err);
  logStream.end();
  process.exit(1);
});
