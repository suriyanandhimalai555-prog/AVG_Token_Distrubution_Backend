import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "0x0000000000000000000000000000000000000000000000000000000000000001";
const ALCHEMY_RPC_URL = process.env.ALCHEMY_RPC_URL ?? "https://bsc-dataseed1.binance.org";
const BSC_TESTNET_RPC_URL =
  process.env.BSC_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    bscTestnet: {
      url: BSC_TESTNET_RPC_URL,
      chainId: 97,
      gasPrice: 10_000_000_000, // 10 gwei
      accounts: [PRIVATE_KEY],
    },
    bscMainnet: {
      url: ALCHEMY_RPC_URL,       // in .env this must be your mainnet Alchemy URL
      chainId: 56,
      gasPrice: 3_000_000_000,    // e.g. 3 gwei, adjust if needed
      accounts: [PRIVATE_KEY],
    },
    hardhat: {
      chainId: 31337,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
