import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

const OUTPUT_DIR = path.resolve(__dirname, "../output");
const WALLETS_CSV = path.join(OUTPUT_DIR, "wallets.csv");
const PLAN_FILE = path.join(OUTPUT_DIR, "distribution-plan.json");

const AMOUNT_MIN = 100;
const AMOUNT_MAX = 300;

export interface DistributionEntry {
  index: number;
  address: string;
  amount: number;          // whole tokens (e.g. 147)
  amountWei: string;       // wei as string (BigInt not JSON-serializable)
  packedHex: string;       // bytes32 hex for multisend calldata
  sent: boolean;
  txHash: string | null;
  timestamp: string | null;
}

function randomAmount(): number {
  // Exact formula as specified
  return Math.floor(Math.random() * (AMOUNT_MAX - AMOUNT_MIN + 1)) + AMOUNT_MIN;
}

function packEntry(address: string, amountWholeTokens: number): string {
  // Pack: address (20 bytes) | uint96 whole-token amount (12 bytes)
  // bytes32 = solidityPacked(["address", "uint96"], [addr, amount])
  return ethers.solidityPacked(["address", "uint96"], [address, amountWholeTokens]);
}

function parseWalletsCsv(filePath: string): Array<{ index: number; address: string }> {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.trim().split("\n");
  // Skip header line
  const wallets: Array<{ index: number; address: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    wallets.push({
      index: parseInt(parts[0], 10),
      address: parts[1],
    });
  }
  return wallets;
}

async function prepareDistribution(): Promise<void> {
  if (!fs.existsSync(WALLETS_CSV)) {
    console.error(`Error: ${WALLETS_CSV} not found.`);
    console.error("Run  npx ts-node scripts/generate-wallets.ts  first.");
    process.exit(1);
  }

  console.log("Reading wallets.csv...");
  const wallets = parseWalletsCsv(WALLETS_CSV);
  console.log(`Loaded ${wallets.length.toLocaleString()} wallets.`);

  console.log("Building distribution plan...");
  const plan: DistributionEntry[] = [];
  let totalTokens = BigInt(0);

  for (const wallet of wallets) {
    const amount = randomAmount();
    const amountWei = BigInt(amount) * BigInt(10 ** 18);
    const packedHex = packEntry(wallet.address, amount);

    plan.push({
      index: wallet.index,
      address: wallet.address,
      amount,
      amountWei: amountWei.toString(),
      packedHex,
      sent: false,
      txHash: null,
      timestamp: null,
    });

    totalTokens += BigInt(amount);
  }

  const minPossible = AMOUNT_MIN * wallets.length;
  const maxPossible = AMOUNT_MAX * wallets.length;

  console.log("\n─── Distribution Summary ────────────────────────");
  console.log(`Total wallets:          ${wallets.length.toLocaleString()}`);
  console.log(`Total tokens to send:   ${totalTokens.toLocaleString()} (whole tokens)`);
  console.log(`Expected minimum:       ${minPossible.toLocaleString()} (${AMOUNT_MIN} × ${wallets.length.toLocaleString()})`);
  console.log(`Expected maximum:       ${maxPossible.toLocaleString()} (${AMOUNT_MAX} × ${wallets.length.toLocaleString()})`);
  console.log(`Total wei:              ${(totalTokens * BigInt(10 ** 18)).toString()}`);
  const BATCH_SIZE = 350;
  console.log(`Batches needed:         ${Math.ceil(wallets.length / BATCH_SIZE).toLocaleString()} (${BATCH_SIZE} wallets/batch)`);
  console.log("─────────────────────────────────────────────────\n");

  console.log(`Writing ${PLAN_FILE}...`);
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");

  console.log(`✓ distribution-plan.json written with ${plan.length.toLocaleString()} entries.`);
  console.log("\nNext step: run  npx ts-node scripts/distribute.ts");
}

prepareDistribution().catch((err: unknown) => {
  console.error("prepare-distribution failed:", err);
  process.exit(1);
});
