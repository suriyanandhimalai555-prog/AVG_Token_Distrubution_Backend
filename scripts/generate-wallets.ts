import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import * as dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

// ─── Paths ────────────────────────────────────────────────────────────────────

const OUTPUT_DIR   = path.resolve(__dirname, "../output");
const WALLETS_CSV  = path.join(OUTPUT_DIR, "wallets.csv");
const MNEMONIC_FILE = path.join(OUTPUT_DIR, "MASTER_MNEMONIC.txt");

/** Default 500 for Nova-style seed; override with TOTAL_WALLETS in `.env`. Must be ≤ 100_000 (MultiSender index range). */
const DEFAULT_TOTAL_WALLETS = 500;
const MAX_TOTAL_WALLETS = 100_000;

function resolveTotalWallets(): number {
  const raw = process.env.TOTAL_WALLETS?.trim();
  if (!raw) return DEFAULT_TOTAL_WALLETS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("TOTAL_WALLETS must be a positive integer");
  }
  if (n > MAX_TOTAL_WALLETS) {
    throw new Error(`TOTAL_WALLETS must be <= ${MAX_TOTAL_WALLETS}`);
  }
  return n;
}

const TOTAL_WALLETS = resolveTotalWallets();
const BIP44_BASE_PATH = "m/44'/60'/0'/0";

// Use all physical cores (capped at 8 — diminishing returns beyond that)
const NUM_WORKERS = Math.min(os.cpus().length, 8);

// ─── Worker thread code (runs in each spawned thread) ─────────────────────────

if (!isMainThread) {
  const { mnemonic, startIndex, endIndex } = workerData as {
    mnemonic: string;
    startIndex: number;
    endIndex: number;
  };

  // Derive the account-level node once — m/44'/60'/0'/0
  // Each child derivation is then just 1 EC multiply (deriveChild(i))
  // vs re-deriving 4 levels from root every time.
  const hdRoot      = ethers.HDNodeWallet.fromPhrase(mnemonic);
  const accountNode = hdRoot.derivePath(`44'/60'/0'/0`);

  const lines: string[] = [];

  for (let i = startIndex; i < endIndex; i++) {
    const child = accountNode.deriveChild(i);
    lines.push(
      `${i},${child.address},${child.privateKey},${BIP44_BASE_PATH}/${i}`
    );
  }

  parentPort!.postMessage(lines);
  process.exit(0);
}

// ─── Main thread ──────────────────────────────────────────────────────────────

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${m}m ${s}s`;
}

async function generateWallets(): Promise<void> {
  ensureOutputDir();

  console.log("Generating random mnemonic...");
  const randomWallet = ethers.Wallet.createRandom();
  const mnemonic = randomWallet.mnemonic?.phrase;
  if (!mnemonic) throw new Error("Failed to generate mnemonic");

  fs.writeFileSync(MNEMONIC_FILE, mnemonic, "utf8");
  console.log(`Master mnemonic saved → ${MNEMONIC_FILE}`);
  console.log(`KEEP THIS FILE SECURE — it controls all ${TOTAL_WALLETS.toLocaleString()} wallets.\n`);

  console.log(`Spawning ${NUM_WORKERS} worker threads across ${os.cpus().length} CPU cores...`);
  console.log(`Total wallets: ${TOTAL_WALLETS.toLocaleString()}\n`);

  const startTime = Date.now();

  // ── Split work evenly across workers ────────────────────────────────────────
  const chunkSize = Math.ceil(TOTAL_WALLETS / NUM_WORKERS);
  const workerPromises: Promise<string[]>[] = [];

  for (let w = 0; w < NUM_WORKERS; w++) {
    const startIndex = w * chunkSize;
    const endIndex   = Math.min(startIndex + chunkSize, TOTAL_WALLETS);

    if (startIndex >= TOTAL_WALLETS) break;

    const promise = new Promise<string[]>((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { mnemonic, startIndex, endIndex },
        // ts-node needs this to re-run itself as a worker
        execArgv: ["-r", "ts-node/register"],
      });

      worker.on("message", (lines: string[]) => resolve(lines));
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
      });
    });

    workerPromises.push(promise);
    console.log(
      `  Worker ${w + 1}/${NUM_WORKERS}: wallets ${startIndex.toLocaleString()} – ${(endIndex - 1).toLocaleString()}`
    );
  }

  console.log("\nAll workers running in parallel...");

  // ── Wait for all workers, collect results ───────────────────────────────────
  const workerResults = await Promise.all(workerPromises);

  // ── Merge in order (workers return their own chunk — sort by first index) ───
  const csvLines: string[] = ["index,address,privateKey,derivationPath"];

  for (const chunk of workerResults) {
    for (const line of chunk) {
      csvLines.push(line);
    }
  }

  // Verify count
  const walletCount = csvLines.length - 1; // subtract header
  console.log(`\nAll workers done. Verifying count: ${walletCount.toLocaleString()} wallets`);

  if (walletCount !== TOTAL_WALLETS) {
    throw new Error(`Expected ${TOTAL_WALLETS} wallets but got ${walletCount}`);
  }

  // ── Write CSV ────────────────────────────────────────────────────────────────
  console.log("Writing wallets.csv...");
  fs.writeFileSync(WALLETS_CSV, csvLines.join("\n"), "utf8");

  const elapsed = (Date.now() - startTime) / 1000;

  console.log(`\n${"═".repeat(55)}`);
  console.log("WALLET GENERATION COMPLETE");
  console.log(`${"═".repeat(55)}`);
  console.log(`Workers used:    ${NUM_WORKERS} (of ${os.cpus().length} CPU cores)`);
  console.log(`Total wallets:   ${TOTAL_WALLETS.toLocaleString()}`);
  console.log(`Time taken:      ${formatDuration(elapsed)}`);
  console.log(`Throughput:      ${Math.round(TOTAL_WALLETS / elapsed).toLocaleString()} wallets/s`);
  console.log(`Output:          ${WALLETS_CSV}`);
  console.log(`Master mnemonic: ${MNEMONIC_FILE}`);
  console.log(`${"═".repeat(55)}`);
  console.log("\nNext step: run  npm run prepare:distribution");
}

generateWallets().catch((err: unknown) => {
  console.error("generate-wallets failed:", err);
  process.exit(1);
});
