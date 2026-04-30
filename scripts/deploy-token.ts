import { ethers } from "hardhat";

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying ABCToken with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "BNB");

  const ABCToken = await ethers.getContractFactory("ABCToken");
  console.log("Deploying...");
  const token = await ABCToken.deploy();
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log("─────────────────────────────────────────────");
  console.log("ABCToken deployed to:", address);
  console.log("─────────────────────────────────────────────");
  console.log("Next step: copy the address above and set it in your .env:");
  console.log(`  TOKEN_ADDRESS=${address}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
