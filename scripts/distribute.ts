import "dotenv/config";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

interface WalletEntry {
  index: number;
  address: string;
  amount: number;
  amountWei: string;
  sent: boolean;
  txHash: string | null;
  timestamp: string | null;
}

interface WorkerData {
  wallets: WalletEntry[];
  tokenAddress: string;
  privateKey: string;
  rpcUrl: string;
  workerId: number;
  nonceStart: number;
}

type WorkerMessage =
  | {
      type: "success";
      workerId: number;
      index: number;
      txHash: string;
      address: string;
      amount: number;
    }
  | {
      type: "error";
      workerId: number;
      index: number;
      address: string;
      error: string;
    }
  | {
      type: "done";
      workerId: number;
    };

const WORKER_COUNT = 5;
const GAS_PRICE_GWEI = "0.05";
const GAS_LIMIT = 65000n;
const CHECKPOINT_EVERY = 50;
const ROOT_DIR = process.cwd();
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "distribute.ts");
const PLAN_PATH = path.join(ROOT_DIR, "output", "distribution-plan.json");
const LOG_PATH = path.join(ROOT_DIR, "output", "distribution.log");
const CSV_LOG_PATH = path.join(ROOT_DIR, "output", "distribution-log.csv");

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (!isMainThread) {
  const data = workerData as WorkerData;

  const runWorker = async (): Promise<void> => {
    const provider = new ethers.JsonRpcProvider(data.rpcUrl);
    const signer = new ethers.Wallet(data.privateKey, provider);
    const token = new ethers.Contract(data.tokenAddress, ERC20_ABI, signer);
    let nonce = data.nonceStart;

    for (const wallet of data.wallets) {
      if (wallet.sent) continue;

      let attempt = 0;
      let success = false;

      while (attempt < 3 && !success) {
        attempt++;
        try {
          const tx = await signer.sendTransaction({
            to: data.tokenAddress,
            data: token.interface.encodeFunctionData("transfer", [
              wallet.address,
              BigInt(wallet.amountWei),
            ]),
            gasLimit: GAS_LIMIT,
            gasPrice: ethers.parseUnits(GAS_PRICE_GWEI, "gwei"),
            nonce,
          });

          const receipt = await tx.wait(1);
          const txHash = receipt?.hash ?? tx.hash;

          wallet.sent = true;
          wallet.txHash = txHash;
          wallet.timestamp = new Date().toISOString();
          nonce++;
          success = true;

          parentPort?.postMessage({
            type: "success",
            workerId: data.workerId,
            index: wallet.index,
            txHash,
            address: wallet.address,
            amount: wallet.amount,
          } satisfies WorkerMessage);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err ?? "");
          const msgLower = msg.toLowerCase();

          if (
            msgLower.includes("nonce too low") ||
            msgLower.includes("replacement transaction")
          ) {
            nonce = await provider.getTransactionCount(signer.address, "pending");
          }

          if (
            msgLower.includes("rate limit") ||
            msgLower.includes("429") ||
            msgLower.includes("too many")
          ) {
            await sleep(3000 * attempt);
          }

          if (attempt < 3) {
            await sleep(2000 * attempt);
          } else {
            parentPort?.postMessage({
              type: "error",
              workerId: data.workerId,
              index: wallet.index,
              address: wallet.address,
              error: msg.slice(0, 120),
            } satisfies WorkerMessage);
          }
        }
      }
    }

    parentPort?.postMessage({
      type: "done",
      workerId: data.workerId,
    } satisfies WorkerMessage);
  };

  runWorker().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err ?? "Worker failed");
    parentPort?.postMessage({
      type: "error",
      workerId: data.workerId,
      index: -1,
      address: "worker",
      error: message.slice(0, 120),
    } satisfies WorkerMessage);
    parentPort?.postMessage({
      type: "done",
      workerId: data.workerId,
    } satisfies WorkerMessage);
  });
}

if (isMainThread) {
  const requiredEnv = [
    "TOKEN_ADDRESS",
    "PRIVATE_KEY",
    "ALCHEMY_RPC_URL",
    "FALLBACK_RPC_1",
    "FALLBACK_RPC_2",
  ] as const;

  function chunkArray<T>(arr: T[], count: number): T[][] {
    if (arr.length === 0) return [];
    const size = Math.ceil(arr.length / count);
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  async function main(): Promise<void> {
    const envPath = path.join(ROOT_DIR, ".env");
    if (fs.existsSync(envPath)) {
      const { config } = await import("dotenv");
      config({ path: envPath });
    }

    const missing = requiredEnv.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      console.error(`Missing required env vars: ${missing.join(", ")}`);
      process.exit(1);
    }

    if (!fs.existsSync(PLAN_PATH)) {
      console.error(`distribution-plan.json not found at: ${PLAN_PATH}`);
      process.exit(1);
    }

    const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8")) as WalletEntry[];
    const unsent = plan.filter((w) => !w.sent);

    if (unsent.length === 0) {
      console.log("All wallets already sent. Nothing to do.");
      process.exit(0);
    }

    console.log("━".repeat(50));
    console.log("PARALLEL TOKEN DISTRIBUTION");
    console.log("━".repeat(50));
    console.log(`Total wallets:  ${plan.length}`);
    console.log(`Already sent:   ${plan.length - unsent.length}`);
    console.log(`Remaining:      ${unsent.length}`);
    console.log(`Workers:        ${WORKER_COUNT}`);
    console.log(`Gas price:      ${GAS_PRICE_GWEI} Gwei`);
    console.log(`Est. cost:      $${(unsent.length * 0.0017).toFixed(2)}`);
    console.log("━".repeat(50));

    const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL!);
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    const bnbBalance = await provider.getBalance(signer.address);
    const bnbFormatted = ethers.formatEther(bnbBalance);
    const estimatedBnb = (unsent.length * Number(GAS_LIMIT) * 0.05e9) / 1e18;

    console.log(`Deployer BNB:   ${parseFloat(bnbFormatted).toFixed(6)} BNB`);
    console.log(`Estimated need: ${estimatedBnb.toFixed(6)} BNB`);
    if (Number(bnbFormatted) < estimatedBnb * 1.1) {
      console.error("WARNING: May not have enough BNB for gas");
    }

    const token = new ethers.Contract(process.env.TOKEN_ADDRESS!, ERC20_ABI, provider);
    const tokenBalance = (await token.balanceOf(signer.address)) as bigint;
    const totalNeeded = unsent.reduce((sum, w) => sum + BigInt(w.amountWei), 0n);
    console.log(`Token balance:  ${ethers.formatEther(tokenBalance)} ABC`);
    console.log(`Tokens needed:  ${ethers.formatEther(totalNeeded)} ABC`);
    if (tokenBalance < totalNeeded) {
      console.error("ERROR: Insufficient token balance. Aborting.");
      process.exit(1);
    }

    const startNonce = await provider.getTransactionCount(signer.address, "pending");
    console.log(`Starting nonce: ${startNonce}`);

    const chunks = chunkArray(unsent, WORKER_COUNT);
    const nonceStarts = chunks.map((_, i) => {
      const offset = chunks.slice(0, i).reduce((sum, chunk) => sum + chunk.length, 0);
      return startNonce + offset;
    });

    const WORKER_RPCS = [
      process.env.ALCHEMY_RPC_URL!,
      process.env.ALCHEMY_RPC_URL!,
      process.env.FALLBACK_RPC_1!,
      process.env.FALLBACK_RPC_1!,
      process.env.FALLBACK_RPC_2!,
    ];

    let totalSuccess = 0;
    let totalFail = 0;
    let pendingSaves = 0;
    const startTime = Date.now();
    const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

    function logLine(line: string): void {
      const ts = new Date().toISOString();
      logStream.write(`[${ts}] ${line}\n`);
    }

    function printProgress(): void {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = elapsed > 0 ? (totalSuccess / elapsed).toFixed(1) : "0.0";
      const pct = (((totalSuccess + totalFail) / unsent.length) * 100).toFixed(1);
      process.stdout.write(
        `\r  [${pct}%] Sent: ${totalSuccess} | Failed: ${totalFail} | Rate: ${rate} tx/s | Elapsed: ${elapsed.toFixed(0)}s   `
      );
    }

    function saveCheckpoint(): void {
      fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2), "utf8");
      logLine(`CHECKPOINT saved — ${totalSuccess} sent`);
    }

    let shuttingDown = false;
    process.on("SIGINT", () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("\n\nInterrupted. Saving checkpoint...");
      fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2), "utf8");
      console.log(`Saved. ${totalSuccess} wallets sent so far.`);
      console.log("Run again to resume from where it stopped.");
      logStream.end();
      process.exit(0);
    });

    const workerPromises = chunks.map((chunk, i) => {
      return new Promise<void>((resolve) => {
        let resolved = false;
        const finish = (): void => {
          if (resolved) return;
          resolved = true;
          resolve();
        };

        const workerBootstrap = `
require("ts-node/register/transpile-only");
require(${JSON.stringify(SCRIPT_PATH)});
`;

        const worker = new Worker(workerBootstrap, {
          eval: true,
          workerData: {
            wallets: chunk,
            tokenAddress: process.env.TOKEN_ADDRESS!,
            privateKey: process.env.PRIVATE_KEY!,
            rpcUrl: WORKER_RPCS[i] ?? WORKER_RPCS[0],
            workerId: i + 1,
            nonceStart: nonceStarts[i],
          } satisfies WorkerData,
        });

        worker.on("message", (msg: WorkerMessage) => {
          if (msg.type === "success") {
            const entry = plan.find((w) => w.index === msg.index);
            if (entry) {
              entry.sent = true;
              entry.txHash = msg.txHash;
              entry.timestamp = new Date().toISOString();
            }

            totalSuccess++;
            pendingSaves++;
            console.log(
              `TX CONFIRMED | Worker ${msg.workerId} | Wallet #${msg.index} | TX: ${msg.txHash} | Amount: ${msg.amount}`
            );
            console.log(`PROGRESS | sent=${totalSuccess} | failed=${totalFail} | total=${unsent.length}`);
            logLine(
              `OK  | worker${msg.workerId} | #${msg.index} | ${msg.address.slice(0, 10)}... | ${msg.amount} ABC | ${msg.txHash}`
            );

            if (pendingSaves >= CHECKPOINT_EVERY) {
              saveCheckpoint();
              pendingSaves = 0;
            }
            printProgress();
            return;
          }

          if (msg.type === "error") {
            if (msg.index >= 0) {
              totalFail++;
            }
            console.log(`PROGRESS | sent=${totalSuccess} | failed=${totalFail} | total=${unsent.length}`);
            logLine(
              `ERR | worker${msg.workerId} | #${msg.index} | ${msg.address.slice(0, 10)}... | ${msg.error}`
            );
            printProgress();
            return;
          }

          if (msg.type === "done") {
            logLine(`Worker ${msg.workerId} finished`);
            finish();
          }
        });

        worker.on("error", (err) => {
          logLine(`Worker ${i + 1} crashed: ${err.message}`);
          finish();
        });

        worker.on("exit", (code) => {
          if (code !== 0) {
            logLine(`Worker ${i + 1} exited with code ${code}`);
          }
          finish();
        });
      });
    });

    console.log("\nAll workers started. Sending transactions...\n");
    await Promise.allSettled(workerPromises);

    const bnbAfter = await provider.getBalance(signer.address);
    const bnbSpent = Number(ethers.formatEther(bnbBalance - bnbAfter));
    saveCheckpoint();
    logStream.end();

    const totalTime = (Date.now() - startTime) / 1000;
    const mins = Math.floor(totalTime / 60);
    const secs = Math.round(totalTime % 60);

    console.log("\n");
    console.log("━".repeat(50));
    console.log("DISTRIBUTION COMPLETE");
    console.log("━".repeat(50));
    console.log(`Sent:       ${totalSuccess} wallets`);
    console.log(`Failed:     ${totalFail} wallets`);
    console.log(`Time:       ${mins}m ${secs}s`);
    console.log(`Rate:       ${(totalSuccess / (totalTime || 1)).toFixed(1)} tx/s`);
    console.log(`Cost est:   ~$${(totalSuccess * 0.0017).toFixed(2)} USD`);
    console.log(
      `Cost est:   ~${((totalSuccess * Number(GAS_LIMIT) * 0.05e9) / 1e18).toFixed(6)} BNB`
    );
    console.log(`BNB spent:  ${bnbSpent.toFixed(6)} BNB`);
    console.log("━".repeat(50));

    if (totalFail > 0) {
      console.log(`\n${totalFail} wallets failed. Run again to retry them.`);
      console.log("Failed wallets are still sent=false in distribution-plan.json");
    }

    const csvRows = plan
      .filter((w) => w.sent && w.txHash)
      .map((w) => `${w.index},${w.address},${w.amount},${w.txHash},${w.timestamp ?? ""}`);
    const csvContent = `index,address,amount,txHash,timestamp\n${csvRows.join("\n")}`;
    fs.writeFileSync(CSV_LOG_PATH, csvContent, "utf8");
    console.log("Log saved: output/distribution-log.csv");
  }

  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err ?? "Distribution failed");
    console.error(`Fatal: ${message}`);
    process.exit(1);
  });
}
