import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { Response } from "express";

// Map of active child processes keyed by sessionId
const activeProcesses = new Map<string, ChildProcess>();

// Map of SSE clients keyed by sessionId
const sseClients = new Map<string, Response[]>();

/**
 * Returns the root directory that contains scripts/, contracts/, output/, .env, etc.
 * Now that the scripts live INSIDE the backend folder, this is simply the backend root.
 *
 * - Default: process.cwd() — always the backend/ directory when started via npm run dev/start
 * - Override: SCRIPTS_DIR env var (useful if you want to point elsewhere)
 */
export function getScriptsDir(): string {
  return path.resolve(process.env.SCRIPTS_DIR ?? process.cwd());
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

export function addSseClient(sessionId: string, res: Response): void {
  const clients = sseClients.get(sessionId) ?? [];
  clients.push(res);
  sseClients.set(sessionId, clients);
}

export function removeSseClient(sessionId: string, res: Response): void {
  const clients = sseClients.get(sessionId) ?? [];
  const filtered = clients.filter((c) => c !== res);
  if (filtered.length === 0) {
    sseClients.delete(sessionId);
  } else {
    sseClients.set(sessionId, filtered);
  }
}

export function emitSseEvent(sessionId: string, event: string, data: unknown): void {
  const clients = sseClients.get(sessionId) ?? [];
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      // client disconnected — ignore
    }
  }
}

// ─── Process control ──────────────────────────────────────────────────────────

export function killProcess(sessionId: string): boolean {
  const proc = activeProcesses.get(sessionId);
  if (!proc) return false;
  proc.kill("SIGTERM");
  activeProcesses.delete(sessionId);
  return true;
}

export function isRunning(sessionId: string): boolean {
  return activeProcesses.has(sessionId);
}

type WalletMode = "HD_SINGLE_SEED" | "INDEPENDENT_SEEDS";

interface ScriptEnvOptions {
  privateKey?: string;
  tokenAddress?: string;
  multisenderAddress?: string;
  totalWallets?: number;
  rpcUrl?: string;
  fallbackRpc1?: string;
  fallbackRpc2?: string;
  walletMode?: WalletMode;
  delayMode?: boolean;
}

/**
 * Build env for child_process spawns.
 * - Inherits PATH, NODE_PATH, etc. from parent process
 * - Injects PRIVATE_KEY, TOKEN_ADDRESS, MULTISENDER_ADDRESS from session (user-entered, never in .env)
 * - TOTAL_WALLETS: session-specific override
 * - All other config (RPC URLs) comes from backend/.env via the scripts' dotenv.config()
 */
function buildChildEnv(opts: ScriptEnvOptions): NodeJS.ProcessEnv {
  const extra: NodeJS.ProcessEnv = {};
  if (opts.privateKey)         extra.PRIVATE_KEY         = opts.privateKey;
  if (opts.tokenAddress)       extra.TOKEN_ADDRESS        = opts.tokenAddress;
  if (opts.multisenderAddress) extra.MULTISENDER_ADDRESS  = opts.multisenderAddress;
  if (opts.totalWallets && opts.totalWallets > 0) extra.TOTAL_WALLETS = String(opts.totalWallets);
  if (opts.rpcUrl)             extra.ALCHEMY_RPC_URL      = opts.rpcUrl;
  if (opts.fallbackRpc1)       extra.FALLBACK_RPC_1       = opts.fallbackRpc1;
  if (opts.fallbackRpc2)       extra.FALLBACK_RPC_2       = opts.fallbackRpc2;
  if (opts.walletMode)         extra.WALLET_MODE          = opts.walletMode;
  if (opts.delayMode !== undefined) extra.DELAY_MODE      = opts.delayMode ? "true" : "false";
  return { ...process.env, ...extra };
}

function forwardSseStdoutLine(sessionId: string, line: string): boolean {
  if (!line.startsWith("SSE:")) return false;
  const rest = line.slice(4);
  const jsonStart = rest.indexOf("{");
  if (jsonStart <= 0) return false;
  const eventPath = rest.slice(0, jsonStart - 1);
  const jsonPart = rest.slice(jsonStart);
  try {
    const data = JSON.parse(jsonPart) as unknown;
    emitSseEvent(sessionId, eventPath, data);
    return true;
  } catch {
    return false;
  }
}

// ─── Regex patterns to parse distribute.ts stdout ─────────────────────────────

const BATCH_CONFIRMED_RE =
  /Batch (\d+)\/(\d+) \| Wallets: (\d+) \| TX: (0x[a-fA-F0-9]+) \| Gas: ([\d,]+) \| CONFIRMED/;

const GROUP_PROGRESS_RE =
  /Group \d+\/\d+ \| ✓ ([\d,]+) sent \| ✗ ([\d,]+) failed/;

const DISTRIBUTION_COMPLETE_RE = /DISTRIBUTION COMPLETE/;

const BNB_SPENT_RE = /BNB spent:\s+([\d.]+) BNB/;
const TX_CONFIRMED_RE =
  /TX CONFIRMED \| Worker (\d+) \| Wallet #(\d+) \| TX: (0x[a-fA-F0-9]+) \| Amount: ([\d.]+)/;
const PROGRESS_RE = /PROGRESS \| sent=(\d+) \| failed=(\d+) \| total=(\d+)/;

// ─── Generate wallets ─────────────────────────────────────────────────────────

export function runGenerate(
  sessionId: string,
  opts: ScriptEnvOptions,
  onProgress: (count: number) => void,
  onDone: (mnemonic: string) => void,
  onError: (err: string) => void
): void {
  const cwd = getScriptsDir();
  const proc = spawn("npx", ["ts-node", "scripts/generate-wallets.ts"], {
    cwd,
    env: buildChildEnv(opts),
    shell: true,
  });

  activeProcesses.set(sessionId, proc);

  let buffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      console.log(`[generate:${sessionId}]`, line.trim());
      emitSseEvent(sessionId, "log", { message: line.trim(), ts: new Date().toISOString() });

      const walletMatch = /Total wallets:\s+([\d,]+)/.exec(line);
      if (walletMatch) {
        const count = parseInt(walletMatch[1].replace(/,/g, ""), 10);
        onProgress(count);
        emitSseEvent(sessionId, "progress", { type: "generate", count });
      }
      if (line.includes("WALLET GENERATION COMPLETE")) {
        emitSseEvent(sessionId, "generateDone", { sessionId });
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    console.error(`[generate:${sessionId}] stderr:`, chunk.toString().trim());
    emitSseEvent(sessionId, "log", { level: "warn", message: chunk.toString().trim() });
  });

  proc.on("close", (code) => {
    activeProcesses.delete(sessionId);
    if (code === 0) {
      const mnemonicPath = path.join(cwd, "output", "MASTER_MNEMONIC.txt");
      let mnemonic = "";
      try {
        mnemonic = fs.readFileSync(mnemonicPath, "utf8").trim();
      } catch {
        /* file may not exist */
      }
      onDone(mnemonic);
    } else {
      onError(`generate-wallets.ts exited with code ${code}`);
    }
  });
}

// ─── Prepare distribution ─────────────────────────────────────────────────────

export function runPrepare(
  sessionId: string,
  opts: Pick<ScriptEnvOptions, "totalWallets">,
  onDone: (totalTokens: string, batchCount: number) => void,
  onError: (err: string) => void
): void {
  const cwd = getScriptsDir();
  const proc = spawn("npx", ["ts-node", "scripts/prepare-distribution.ts"], {
    cwd,
    env: buildChildEnv(opts),
    shell: true,
  });

  activeProcesses.set(sessionId, proc);

  let totalTokens = "0";
  let batchCount = 0;

  proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    console.log(`[prepare:${sessionId}]`, text.trim());
    emitSseEvent(sessionId, "log", { message: text.trim(), ts: new Date().toISOString() });

    const tokensMatch = /Total tokens to send:\s+([\d,]+)/.exec(text);
    if (tokensMatch) totalTokens = tokensMatch[1].replace(/,/g, "");

    const batchMatch = /Batches needed:\s+([\d,]+)/.exec(text);
    if (batchMatch) batchCount = parseInt(batchMatch[1].replace(/,/g, ""), 10);
    const txMatch = /On-chain txs \(est\.\):\s+([\d,]+)/.exec(text);
    if (txMatch) batchCount = parseInt(txMatch[1].replace(/,/g, ""), 10);
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    console.error(`[prepare:${sessionId}] stderr:`, chunk.toString().trim());
  });

  proc.on("close", (code) => {
    activeProcesses.delete(sessionId);
    if (code === 0) {
      onDone(totalTokens, batchCount);
    } else {
      onError(`prepare-distribution.ts exited with code ${code}`);
    }
  });
}

// ─── Distribute ───────────────────────────────────────────────────────────────

export function runDistribute(
  sessionId: string,
  opts: ScriptEnvOptions,
  onBatch: (batchIndex: number, totalBatches: number, walletCount: number, txHash: string, gasUsed: string) => void,
  onProgress: (sentCount: number, failedCount: number) => void,
  onDone: (bnbSpent: number) => void,
  onError: (err: string) => void
): void {
  const cwd = getScriptsDir();
  const proc = spawn("npx", ["ts-node", "scripts/distribute.ts"], {
    cwd,
    env: buildChildEnv(opts),
    shell: true,
  });

  activeProcesses.set(sessionId, proc);

  let lineBuffer = "";
  let finalBnbSpent = 0;

  proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    lineBuffer += text;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      console.log(`[distribute:${sessionId}]`, line.trim());

      if (forwardSseStdoutLine(sessionId, line.trim())) {
        continue;
      }

      const batchMatch = BATCH_CONFIRMED_RE.exec(line);
      if (batchMatch) {
        const batchIndex = parseInt(batchMatch[1], 10);
        const totalBatches = parseInt(batchMatch[2], 10);
        const walletCount = parseInt(batchMatch[3], 10);
        const txHash = batchMatch[4];
        const gasUsed = batchMatch[5].replace(/,/g, "");
        onBatch(batchIndex, totalBatches, walletCount, txHash, gasUsed);
        emitSseEvent(sessionId, "batch", {
          batchIndex,
          totalBatches,
          walletCount,
          txHash,
          gasUsed,
          status: "confirmed",
          timestamp: new Date().toISOString(),
        });
      }

      const groupMatch = GROUP_PROGRESS_RE.exec(line);
      if (groupMatch) {
        const sentCount = parseInt(groupMatch[1].replace(/,/g, ""), 10);
        const failedCount = parseInt(groupMatch[2].replace(/,/g, ""), 10);
        onProgress(sentCount, failedCount);
        emitSseEvent(sessionId, "stats", { sentCount, failedCount });
      }

      const progressMatch = PROGRESS_RE.exec(line);
      if (progressMatch) {
        const sentCount = parseInt(progressMatch[1], 10);
        const failedCount = parseInt(progressMatch[2], 10);
        const totalCount = parseInt(progressMatch[3], 10);
        onProgress(sentCount, failedCount);
        emitSseEvent(sessionId, "stats", { sentCount, failedCount, totalCount });
      }

      const txMatch = TX_CONFIRMED_RE.exec(line);
      if (txMatch) {
        const workerId = parseInt(txMatch[1], 10);
        const walletIndex = parseInt(txMatch[2], 10);
        const txHash = txMatch[3];
        const amount = txMatch[4];
        onBatch(walletIndex + 1, 0, 1, txHash, "65000");
        emitSseEvent(sessionId, "batch", {
          workerId,
          walletIndex,
          walletCount: 1,
          txHash,
          amount,
          status: "confirmed",
          timestamp: new Date().toISOString(),
        });
      }

      const bnbMatch = BNB_SPENT_RE.exec(line);
      if (bnbMatch) {
        finalBnbSpent = parseFloat(bnbMatch[1]);
        emitSseEvent(sessionId, "stats", { bnbSpent: finalBnbSpent });
      }

      if (DISTRIBUTION_COMPLETE_RE.test(line)) {
        emitSseEvent(sessionId, "done", { sessionId, bnbSpent: finalBnbSpent });
      }

      // Forward all lines as live log events
      emitSseEvent(sessionId, "log", { message: line.trim(), ts: new Date().toISOString() });
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    console.error(`[distribute:${sessionId}] stderr:`, text);
    emitSseEvent(sessionId, "log", { level: "error", message: text, ts: new Date().toISOString() });
  });

  proc.on("close", (code) => {
    activeProcesses.delete(sessionId);
    if (code === 0) {
      onDone(finalBnbSpent);
    } else if (code !== null) {
      onError(`distribute.ts exited with code ${code}`);
      emitSseEvent(sessionId, "error", { message: `Process exited with code ${code}` });
    }
  });
}
