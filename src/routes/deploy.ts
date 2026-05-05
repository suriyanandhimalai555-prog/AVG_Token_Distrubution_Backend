import { Router, Request, Response } from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { getScriptsDir } from "../lib/runner";
import { requireAuth } from "../middleware/requireAuth";
import { requirePlan } from "../middleware/requirePlan";

const router = Router();

const VALID_NETWORKS = ["bscMainnet", "bscTestnet"] as const;
type Network = (typeof VALID_NETWORKS)[number];

/**
 * POST /api/deploy/multisender
 * Body: { privateKey: string, network?: "bscMainnet" | "bscTestnet" }
 *
 * Spawns: npx hardhat run scripts/deploy-multisender.ts --network <network>
 * Writes result to output/deployments.json
 * Returns: { address, network, chainId, deployedAt }
 */
router.post("/multisender", requireAuth, requirePlan, (req: Request, res: Response) => {
  const { privateKey, network = "bscMainnet" } = req.body as {
    privateKey: string;
    network?: string;
  };

  if (!privateKey || !privateKey.trim()) {
    return res.status(400).json({ error: "privateKey is required — enter it in the Private Key field first" });
  }

  if (!VALID_NETWORKS.includes(network as Network)) {
    return res.status(400).json({ error: `network must be one of: ${VALID_NETWORKS.join(", ")}` });
  }

  const cwd = getScriptsDir();

  // Hardhat config expects private key WITHOUT 0x prefix
  const pk = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;

  console.log(`[deploy] Starting MultiSender deploy on ${network}...`);

  const proc = spawn(
    "npx",
    ["hardhat", "run", "scripts/deploy-multisender.ts", "--network", network],
    {
      cwd,
      env: {
        ...process.env,
        PRIVATE_KEY: pk,
      },
      shell: true,
    }
  );

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    console.log("[deploy:multisender]", text.trim());
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    // Hardhat logs some info to stderr — only treat non-empty lines as errors
    if (text.trim()) console.warn("[deploy:multisender stderr]", text.trim());
  });

  proc.on("close", (code, signal) => {
    if (code !== 0) {
      console.error("[deploy] Process exited with code", code, "signal", signal);
      const details = (stderr + stdout).trim().slice(-800); // last 800 chars for context
      return res.status(500).json({
        error: signal
          ? `Deployment process was interrupted (${signal}). Please retry.`
          : "Deployment failed. Check that your private key has enough BNB for gas.",
        details: details || `exit_code=${String(code)} signal=${String(signal ?? "")}`,
      });
    }

    // deploy-multisender.ts writes to output/deployments.json — read it
    const deploymentsPath = path.join(cwd, "output", "deployments.json");
    try {
      const raw = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
      const { address, network: net, chainId, deployedAt } = raw.multisender;
      console.log("[deploy] Success →", address);
      return res.json({ address, network: net, chainId, deployedAt });
    } catch {
      // Fallback: parse address from stdout
      const match = /MultiSender deployed to:\s*(0x[a-fA-F0-9]{40})/.exec(stdout);
      if (match) {
        console.log("[deploy] Success (from stdout) →", match[1]);
        return res.json({ address: match[1] });
      }
      return res.status(500).json({
        error: "Deployed but could not read address from deployments.json",
        stdout: stdout.slice(-400),
      });
    }
  });

  // Important: do NOT kill on req.close here.
  // In Express, req.close can fire after request body is fully read,
  // which can terminate long-running child processes prematurely.
});

export default router;
