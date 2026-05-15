import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { Session } from "../models/Session";
import { requireAuth } from "../middleware/requireAuth";
import { requirePlan } from "../middleware/requirePlan";
import { countBatchesForWalletCount, resolveMultiBatchSizeFromEnv } from "../lib/distributionBatching";

const router = Router();

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function resolveParallelWorkerCount(): number {
  return Math.max(1, Math.min(10, Number(process.env.PARALLEL_BATCHES ?? 1)));
}

/** Matches scripts/distribute.ts multisend tx gasLimit cap. */
const GAS_LIMIT_MULTISEND = 4_000_000n;
const GAS_PRICE_GWEI = "0.05";

function resolveRpcUrl(network: "bscMainnet" | "bscTestnet"): string {
  if (network === "bscTestnet") {
    return (
      process.env.BSC_TESTNET_RPC_URL ||
      process.env.ALCHEMY_RPC_URL ||
      process.env.FALLBACK_RPC_1 ||
      ""
    );
  }
  return (
    process.env.ALCHEMY_RPC_URL ||
    process.env.FALLBACK_RPC_1 ||
    process.env.FALLBACK_RPC_2 ||
    ""
  );
}

function resolveMainnetRpcUrl(): string {
  return (
    process.env.ALCHEMY_RPC_URL ||
    process.env.FALLBACK_RPC_1 ||
    process.env.FALLBACK_RPC_2 ||
    ""
  );
}

router.post("/preflight", requireAuth, requirePlan, async (req: Request, res: Response) => {
  try {
    const { sessionId, privateKey, network: requestedNetwork } = req.body as {
      sessionId: string;
      privateKey: string;
      network?: "bscMainnet" | "bscTestnet";
    };

    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    if (!privateKey?.trim()) return res.status(400).json({ error: "privateKey is required" });

    const session = await Session.findById(sessionId).lean();
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (!session.userId || session.userId.toString() !== req.user!._id.toString()) {
      return res.status(404).json({ error: "Session not found" });
    }

    const targetNetwork =
      requestedNetwork === "bscTestnet" || requestedNetwork === "bscMainnet"
        ? requestedNetwork
        : (session.network === "bscTestnet" ? "bscTestnet" : "bscMainnet");
    const rpcUrl = resolveRpcUrl(targetNetwork);
    if (!rpcUrl) return res.status(500).json({ error: "RPC URL missing in backend .env" });

    const normalizedPk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(normalizedPk, provider);
    const account = wallet.address;

    let chainId = targetNetwork === "bscTestnet" ? 97 : 56;
    let bnbWei = 0n;
    try {
      const [network, bal] = await Promise.all([
        provider.getNetwork(),
        provider.getBalance(account),
      ]);
      chainId = Number(network.chainId);
      bnbWei = bal;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Failed to read ${targetNetwork} balance: ${msg}` });
    }

    // Token lookup:
    // 1) Try selected network RPC first
    // 2) If it fails (e.g., mainnet token while on testnet), fallback to mainnet RPC
    let symbolRaw: string = session.tokenName || "TOKEN";
    let decimalsRaw = 18;
    let tokenBalRaw = 0n;
    let tokenSourceNetwork: "selected" | "mainnet-fallback" = "selected";
    let tokenError: string | undefined;

    try {
      const token = new ethers.Contract(session.tokenAddress, ERC20_ABI, provider);
      const [s, d, b] = await Promise.all([
        token.symbol(),
        token.decimals(),
        token.balanceOf(account),
      ]);
      symbolRaw = String(s);
      decimalsRaw = Number(d);
      tokenBalRaw = BigInt(b);
    } catch (err) {
      const mainnetRpc = resolveMainnetRpcUrl();
      if (mainnetRpc) {
        try {
          const mainnetProvider = new ethers.JsonRpcProvider(mainnetRpc);
          const tokenMain = new ethers.Contract(session.tokenAddress, ERC20_ABI, mainnetProvider);
          const [s, d, b] = await Promise.all([
            tokenMain.symbol(),
            tokenMain.decimals(),
            tokenMain.balanceOf(account),
          ]);
          symbolRaw = String(s);
          decimalsRaw = Number(d);
          tokenBalRaw = BigInt(b);
          tokenSourceNetwork = "mainnet-fallback";
        } catch (err2) {
          const msg = err2 instanceof Error ? err2.message : String(err2);
          tokenError = msg;
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        tokenError = msg;
      }
    }

    const totalWallets = session.totalWallets;
    const requiredMinTokens = totalWallets * 1;
    const requiredAvgTokens = Math.round(totalWallets * 50.5);
    const requiredMaxTokens = totalWallets * 100;
    const batchSize = resolveMultiBatchSizeFromEnv();
    const batchCount = countBatchesForWalletCount(totalWallets, batchSize);

    const gasPriceWei = ethers.parseUnits(GAS_PRICE_GWEI, "gwei");
    const estimatedMaxGasPerTxLikely = GAS_LIMIT_MULTISEND;
    const estimatedGasLikely = GAS_LIMIT_MULTISEND * BigInt(batchCount);
    const estimatedGasMax = estimatedGasLikely;
    const estimatedBnbLikelyWei = estimatedGasLikely * gasPriceWei;
    const estimatedBnbMaxWei = estimatedGasMax * gasPriceWei;

    const tokenBalanceFloat = Number(ethers.formatUnits(tokenBalRaw, Number(decimalsRaw)));
    const bnbBalanceFloat = Number(ethers.formatEther(bnbWei));
    const estLikelyBnbFloat = Number(ethers.formatEther(estimatedBnbLikelyWei));
    const estMaxBnbFloat = Number(ethers.formatEther(estimatedBnbMaxWei));

    return res.json({
      account,
      chainId,
      network: targetNetwork,
      nativeSymbol: targetNetwork === "bscTestnet" ? "tBNB" : "BNB",
      totalWallets,
      batchSize,
      batchCount,
      workerCount: resolveParallelWorkerCount(),
      token: {
        address: session.tokenAddress,
        symbol: String(symbolRaw),
        decimals: Number(decimalsRaw),
        balance: ethers.formatUnits(tokenBalRaw, Number(decimalsRaw)),
        requiredMin: requiredMinTokens,
        requiredAvg: requiredAvgTokens,
        requiredMax: requiredMaxTokens,
        enoughForMax: tokenBalanceFloat >= requiredMaxTokens,
      },
      tokenSourceNetwork,
      tokenError,
      gas: {
        gasPriceGwei: GAS_PRICE_GWEI,
        estimatedGasLikely: estimatedGasLikely.toString(),
        estimatedGasMax: estimatedGasMax.toString(),
        estimatedLikelyGasPerLargestBatch: estimatedMaxGasPerTxLikely.toString(),
        perBatchGasLimit: GAS_LIMIT_MULTISEND.toString(),
        mayExceedPerBatchLimit: false,
        estimatedBnbLikely: ethers.formatEther(estimatedBnbLikelyWei),
        estimatedBnbMax: ethers.formatEther(estimatedBnbMaxWei),
      },
      bnb: {
        balance: ethers.formatEther(bnbWei),
        enoughLikely: bnbBalanceFloat >= estLikelyBnbFloat,
        enoughMax: bnbBalanceFloat >= estMaxBnbFloat,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to estimate preflight";
    return res.status(500).json({ error: msg });
  }
});

export default router;

