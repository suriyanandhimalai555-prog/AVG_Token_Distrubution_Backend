import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Session } from "../models/Session";
import { Wallet } from "../models/Wallet";
import { Batch } from "../models/Batch";
import { getScriptsDir } from "../lib/runner";
import ExcelJS from "exceljs";
import { ethers } from "ethers";

const router = Router();
const ERC20_ABI = [
  "function name() view returns (string)",
];
interface PlanEntry {
  index: number;
  txHash?: string | null;
  sent?: boolean;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

async function resolveTokenName(tokenAddress: string): Promise<string> {
  let tokenName = "TOKEN";
  try {
    const rpcUrl =
      process.env.ALCHEMY_RPC_URL ||
      process.env.FALLBACK_RPC_1 ||
      process.env.FALLBACK_RPC_2 ||
      "";
    if (rpcUrl && tokenAddress) {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      tokenName = String(await token.name());
    }
  } catch {
    // keep fallback tokenName
  }
  return tokenName;
}

// GET /api/export?sessionId=xxx&file=csv|xlsx|wallets|json
router.get("/", async (req: Request, res: Response) => {
  try {
    const { sessionId, file } = req.query as { sessionId: string; file: string };
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    if (!["csv", "xlsx", "wallets", "json"].includes(file)) {
      return res.status(400).json({ error: "file must be one of: csv, xlsx, wallets, json" });
    }

    const session = await Session.findById(sessionId).lean();
    if (!session) return res.status(404).json({ error: "Session not found" });

    const scriptsDir = getScriptsDir();

    if (file === "wallets") {
      const csvPath = path.join(scriptsDir, "output", "wallets.csv");
      if (!fs.existsSync(csvPath)) {
        return res.status(404).json({ error: "wallets.csv not found" });
      }
      res.setHeader("Content-Disposition", "attachment; filename=wallets.csv");
      res.setHeader("Content-Type", "text/csv");
      fs.createReadStream(csvPath).pipe(res);
      return;
    }

    if (file === "json") {
      const planPath = path.join(scriptsDir, "output", "distribution-plan.json");
      if (!fs.existsSync(planPath)) {
        return res.status(404).json({ error: "distribution-plan.json not found" });
      }
      res.setHeader("Content-Disposition", "attachment; filename=distribution-plan.json");
      res.setHeader("Content-Type", "application/json");
      fs.createReadStream(planPath).pipe(res);
      return;
    }

    // For csv and xlsx, fetch from MongoDB
    const wallets = await Wallet.find({ sessionId })
      .sort({ index: 1 })
      .lean();
    const tokenName = await resolveTokenName(session.tokenAddress);

    // Use distribution-plan.json as authoritative source of per-wallet tx hashes.
    // This avoids mismatch when DB sync lags or session is partially updated.
    const planPath = path.join(scriptsDir, "output", "distribution-plan.json");
    const txHashByIndex = new Map<number, string>();
    if (fs.existsSync(planPath)) {
      try {
        const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as PlanEntry[];
        for (const p of plan) {
          if (typeof p.index === "number" && p.txHash) {
            txHashByIndex.set(p.index, String(p.txHash));
          }
        }
      } catch {
        // ignore malformed plan file; fallback to DB tx hashes
      }
    }

    if (file === "csv") {
      res.setHeader("Content-Disposition", "attachment; filename=distribution-log.csv");
      res.setHeader("Content-Type", "text/csv");

      const lines = [
        "Wallet Address,Seed Phrase (Mnemonic),Network,Native Balance,Token Name,Token Contract Address,Token Balance,Transaction Hash",
      ];
      for (const w of wallets) {
        const txHash = txHashByIndex.get(w.index) ?? (w.txHash ?? "");
        lines.push(
          [
            csvEscape(w.address),
            "", // intentionally blank for now; will be filled from backend later
            "BNB",
            "0.0",
            csvEscape(tokenName),
            csvEscape(session.tokenAddress),
            String(w.amount ?? 0),
            csvEscape(String(txHash)),
          ].join(",")
        );
      }
      return res.send(lines.join("\n"));
    }

    if (file === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Wallet Distribution");

      sheet.columns = [
        { header: "Wallet Address", key: "walletAddress", width: 44 },
        { header: "Seed Phrase (Mnemonic)", key: "mnemonic", width: 42 },
        { header: "Network", key: "network", width: 10 },
        { header: "Native Balance", key: "nativeBalance", width: 16 },
        { header: "Token Name", key: "tokenName", width: 18 },
        { header: "Token Contract Address", key: "tokenContractAddress", width: 44 },
        { header: "Token Balance", key: "tokenBalance", width: 16 },
        { header: "Transaction Hash", key: "transactionHash", width: 68 },
      ];

      for (const w of wallets) {
        const txHash = txHashByIndex.get(w.index) ?? (w.txHash ?? "");
        sheet.addRow({
          walletAddress: w.address,
          mnemonic: "", // intentionally blank for now; will be filled from backend later
          network: "BNB",
          nativeBalance: "0.0",
          tokenName,
          tokenContractAddress: session.tokenAddress,
          tokenBalance: String(w.amount ?? 0),
          transactionHash: txHash,
        });
      }

      res.setHeader("Content-Disposition", "attachment; filename=distribution-log.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

      await workbook.xlsx.write(res);
      return res.end();
    }
  } catch (err) {
    console.error("[export GET]", err);
    return res.status(500).json({ error: "Failed to export file" });
  }
});

export default router;
