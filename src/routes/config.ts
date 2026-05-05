import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { getScriptsDir } from "../lib/runner";
import { requireAuth } from "../middleware/requireAuth";
import { requirePlan } from "../middleware/requirePlan";

const router = Router();

/**
 * GET /api/config
 * Returns:
 *  - RPC URLs from process.env first (Railway), else parsed scriptsDir/.env file
 *  - multisender from output/deployments.json (written by deploy-multisender.ts)
 *  - Does NOT return PRIVATE_KEY or TOKEN_ADDRESS (user provides those in the form)
 */
router.get("/", requireAuth, requirePlan, (_req: Request, res: Response) => {
  try {
    const scriptsDir = getScriptsDir();
    const envPath = path.join(scriptsDir, ".env");

    // RPC URLs: prefer process.env (Railway / Docker inject vars here).
    // Local dev often uses a .env file — dotenv loads into process.env, but we also
    // parse the file as fallback when vars exist only on disk or SCRIPTS_DIR differs.
    const fileEnv: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        fileEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }

    const pick = (key: string): string =>
      String(process.env[key] ?? fileEnv[key] ?? "").trim();

    // Read deployments.json for MULTISENDER_ADDRESS
    const deploymentsPath = path.join(scriptsDir, "output", "deployments.json");
    let multisenderAddress = "";
    let deploymentInfo: Record<string, string> = {};
    if (fs.existsSync(deploymentsPath)) {
      try {
        const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
        if (deployments.multisender?.address) {
          multisenderAddress = deployments.multisender.address;
          deploymentInfo = {
            network: deployments.multisender.network ?? "",
            chainId: deployments.multisender.chainId ?? "",
            deployedAt: deployments.multisender.deployedAt ?? "",
          };
        }
      } catch {
        /* malformed JSON — ignore */
      }
    }

    return res.json({
      rpcUrl: pick("ALCHEMY_RPC_URL"),
      testnetRpcUrl: pick("BSC_TESTNET_RPC_URL"),
      fallback1: pick("FALLBACK_RPC_1"),
      fallback2: pick("FALLBACK_RPC_2"),
      multisenderAddress,
      deploymentInfo,
      // TOKEN_ADDRESS and PRIVATE_KEY are NOT returned — user enters them in the form
    });
  } catch (err) {
    console.error("[config GET]", err);
    return res.status(500).json({ error: "Failed to read config" });
  }
});

export default router;
