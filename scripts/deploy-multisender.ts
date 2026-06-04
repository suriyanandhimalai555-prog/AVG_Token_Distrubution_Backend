import hre from "hardhat";
import { ethers, type InterfaceAbi } from "ethers";
import * as fs from "fs";
import * as path from "path";

const OUTPUT_DIR = path.resolve(__dirname, "../output");
const DEPLOYMENTS_FILE = path.join(OUTPUT_DIR, "deployments.json");
const ARTIFACT_PATH = path.resolve(__dirname, "../artifacts/contracts/MultiSender.sol/MultiSender.json");

function resolveRpcUrl(networkName: string): string {
  if (networkName === "bscMainnet") {
    return (
      process.env.ALCHEMY_RPC_URL ||
      process.env.FALLBACK_RPC_1 ||
      process.env.FALLBACK_RPC_2 ||
      ""
    );
  }
  if (networkName === "bscTestnet") {
    return (
      process.env.BSC_TESTNET_RPC_URL ||
      process.env.ALCHEMY_RPC_URL ||
      ""
    );
  }
  return process.env.ALCHEMY_RPC_URL || "";
}

async function main(): Promise<void> {
  const networkName = hre.network.name;
  const rpcUrl = resolveRpcUrl(networkName);
  if (!rpcUrl) {
    throw new Error(`Missing RPC URL for network ${networkName}. Check .env.`);
  }

  const privateKeyRaw = process.env.PRIVATE_KEY ?? "";
  if (!privateKeyRaw) {
    throw new Error("PRIVATE_KEY missing in environment.");
  }
  const privateKey = privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployer = new ethers.Wallet(privateKey, provider);

  console.log("Deploying MultiSender with account:", deployer.address);
  const balance = await provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "BNB");
  console.log("Network:", networkName);

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8")) as {
    abi: InterfaceAbi;
    bytecode: string;
  };

  const feeData = await provider.getFeeData();
  const deployOverrides = feeData.gasPrice ? { gasPrice: feeData.gasPrice } : {};

  console.log("Deploying...");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const multisender = await factory.deploy(deployOverrides);
  const deployTx = multisender.deploymentTransaction();
  if (!deployTx) throw new Error("Deployment transaction not found.");
  console.log("Deployment tx:", deployTx.hash);
  await deployTx.wait();

  const address = await multisender.getAddress();
  const network = await provider.getNetwork();

  console.log("─────────────────────────────────────────────");
  console.log("MultiSender deployed to:", address);
  console.log("Network:", network.name, "(chainId:", network.chainId.toString() + ")");
  console.log("─────────────────────────────────────────────");

  // ── Save to output/deployments.json so the dashboard auto-loads it ──────────
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const existing = fs.existsSync(DEPLOYMENTS_FILE)
    ? JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"))
    : {};

  const updated = {
    ...existing,
    multisender: {
      address,
      network: network.name,
      chainId: network.chainId.toString(),
      deployedAt: new Date().toISOString(),
    },
  };

  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(updated, null, 2), "utf8");
  console.log(`✓ Saved to ${DEPLOYMENTS_FILE}`);
  console.log("The dashboard will auto-read MULTISENDER_ADDRESS from this file.");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
