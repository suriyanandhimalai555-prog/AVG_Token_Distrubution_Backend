import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { getScriptsDir } from "../lib/runner";

const router = Router();

/**
 * GET /api/config
 * Returns:
 *  - RPC URLs from .env
 *  - MULTISENDER_ADDRESS from output/deployments.json (written by deploy-multisender.ts)
 *  - Does NOT return PRIVATE_KEY or TOKEN_ADDRESS (user provides those in the form)
 */
router.get("/", (_req: Request, res: Response) => {
  try {
    const scriptsDir = getScriptsDir();
    const envPath = path.join(scriptsDir, ".env");

    // Read .env for RPC URLs only
    const envValues: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        envValues[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }

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
      rpcUrl: envValues.ALCHEMY_RPC_URL ?? "",
      testnetRpcUrl: envValues.BSC_TESTNET_RPC_URL ?? "",
      fallback1: envValues.FALLBACK_RPC_1 ?? "",
      fallback2: envValues.FALLBACK_RPC_2 ?? "",
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
