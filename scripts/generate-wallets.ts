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

type GenerationMode = "HD_SINGLE_SEED" | "INDEPENDENT_SEEDS";

function resolveGenerationMode(): GenerationMode {
  const mode = (process.env.WALLET_MODE as GenerationMode | undefined) ?? "INDEPENDENT_SEEDS";
  if (mode !== "HD_SINGLE_SEED" && mode !== "INDEPENDENT_SEEDS") {
    throw new Error("WALLET_MODE must be INDEPENDENT_SEEDS or HD_SINGLE_SEED");
  }
  return mode;
}

const GENERATION_MODE: GenerationMode = resolveGenerationMode();

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

function log(message: string): void {
  console.log(message);
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function endCsvStream(csvStream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    csvStream.on("finish", resolve);
    csvStream.on("error", reject);
    csvStream.end();
  });
}

async function generateHdWallets(
  totalWallets: number,
  outputPath: string,
  mnemonicPath: string
): Promise<void> {
  ensureOutputDir();

  console.log("Generating random mnemonic...");
  const randomWallet = ethers.Wallet.createRandom();
  const mnemonic = randomWallet.mnemonic?.phrase;
  if (!mnemonic) throw new Error("Failed to generate mnemonic");

  fs.writeFileSync(mnemonicPath, mnemonic, "utf8");
  console.log(`Master mnemonic saved → ${mnemonicPath}`);
  console.log(`KEEP THIS FILE SECURE — it controls all ${totalWallets.toLocaleString()} wallets.\n`);

  console.log(`Spawning ${NUM_WORKERS} worker threads across ${os.cpus().length} CPU cores...`);
  console.log(`Total wallets: ${totalWallets.toLocaleString()}\n`);

  const startTime = Date.now();

  // ── Split work evenly across workers ────────────────────────────────────────
  const chunkSize = Math.ceil(totalWallets / NUM_WORKERS);
  const workerPromises: Promise<string[]>[] = [];

  for (let w = 0; w < NUM_WORKERS; w++) {
    const startIndex = w * chunkSize;
    const endIndex   = Math.min(startIndex + chunkSize, totalWallets);

    if (startIndex >= totalWallets) break;

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

  if (walletCount !== totalWallets) {
    throw new Error(`Expected ${totalWallets} wallets but got ${walletCount}`);
  }

  // ── Write CSV ────────────────────────────────────────────────────────────────
  console.log("Writing wallets.csv...");
  fs.writeFileSync(outputPath, csvLines.join("\n"), "utf8");

  const elapsed = (Date.now() - startTime) / 1000;

  console.log(`\n${"═".repeat(55)}`);
  console.log("WALLET GENERATION COMPLETE");
  console.log(`${"═".repeat(55)}`);
  console.log(`Workers used:    ${NUM_WORKERS} (of ${os.cpus().length} CPU cores)`);
  console.log(`Total wallets:   ${totalWallets.toLocaleString()}`);
  console.log(`Time taken:      ${formatDuration(elapsed)}`);
  console.log(`Throughput:      ${Math.round(totalWallets / elapsed).toLocaleString()} wallets/s`);
  console.log(`Output:          ${outputPath}`);
  console.log(`Master mnemonic: ${mnemonicPath}`);
  console.log(`${"═".repeat(55)}`);
  console.log("\nNext step: run  npm run prepare:distribution");
}

async function generateIndependentWallets(
  totalWallets: number,
  outputPath: string,
  mnemonicDir: string
): Promise<void> {
  ensureOutputDir();

  log(`Generating ${totalWallets.toLocaleString()} wallets — INDEPENDENT mode`);
  log("Each wallet has its own unique seed phrase");
  log("This may take longer than HD mode...");
  log(`Estimated time: ${formatDuration((totalWallets * 2) / 1000)} (~2ms per wallet)`);

  if (totalWallets > 10_000) {
    log(
      `WARNING: independent mode will create ${totalWallets.toLocaleString()} individual mnemonic files.`
    );
  }

  // Each generated wallet gets a standalone seed backup file.
  const mnemonicFolder = path.join(mnemonicDir, "mnemonics");
  if (!fs.existsSync(mnemonicFolder)) {
    fs.mkdirSync(mnemonicFolder, { recursive: true });
  }

  const startTime = Date.now();
  const csvStream = fs.createWriteStream(outputPath);
  csvStream.write("index,address,privateKey,mnemonic,derivationPath\n");

  const LOG_EVERY = 1000;

  for (let i = 0; i < totalWallets; i++) {
    const randomWallet = ethers.Wallet.createRandom();
    const entry = {
      index: i,
      address: randomWallet.address,
      privateKey: randomWallet.privateKey,
      mnemonic: randomWallet.mnemonic?.phrase ?? "",
      derivationPath: "independent",
    };

    csvStream.write(
      `${entry.index},${entry.address},${entry.privateKey},` +
        `${csvEscape(entry.mnemonic)},${entry.derivationPath}\n`
    );

    fs.writeFileSync(
      path.join(mnemonicFolder, `wallet-${i}.txt`),
      [
        `Wallet Index: ${i}`,
        `Address:      ${entry.address}`,
        `Mnemonic:     ${entry.mnemonic}`,
        `Generated:    ${new Date().toISOString()}`,
        "",
        "KEEP THIS SAFE. Never share your seed phrase.",
      ].join("\n"),
      "utf8"
    );

    if ((i + 1) % LOG_EVERY === 0 || i === totalWallets - 1) {
      log(
        `Generated ${(i + 1).toLocaleString()} / ${totalWallets.toLocaleString()} wallets`
      );
    }
  }

  await endCsvStream(csvStream);

  const elapsed = (Date.now() - startTime) / 1000;
  log(`Wallets saved to: ${outputPath}`);
  log(`Mnemonics saved to: ${mnemonicFolder}`);
  log(`Total wallets generated: ${totalWallets.toLocaleString()}`);
  log(`Time taken: ${formatDuration(elapsed)}`);
}

async function main(): Promise<void> {
  if (GENERATION_MODE === "INDEPENDENT_SEEDS") {
    await generateIndependentWallets(TOTAL_WALLETS, WALLETS_CSV, OUTPUT_DIR);
  } else {
    await generateHdWallets(TOTAL_WALLETS, WALLETS_CSV, MNEMONIC_FILE);
  }
}

main().catch((err: unknown) => {
  console.error("generate-wallets failed:", err);
  process.exit(1);
});
