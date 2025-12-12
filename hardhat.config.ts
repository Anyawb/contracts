import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@openzeppelin/hardhat-upgrades';
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomicfoundation/hardhat-ethers';
import 'dotenv/config';
import 'hardhat-contract-sizer';
import './scripts/tasks/registry-migrate';
import './scripts/tasks/registry-verify';
import './scripts/tasks/registry-check';
import './scripts/tasks/registry-set';
import './scripts/tasks/registry-sync';
import './scripts/tasks/utils-tasks';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: {
        enabled: true,
        runs: 800,
      },
      viaIR: true, // 启用 viaIR 解决 Stack too deep 错误
      metadata: {
        bytecodeHash: 'none',
      },
    },
  },
  paths: {
    // 仅扫描 ./src 来避免将 node_modules 误判为本地源码
    sources: './src',
  },
  networks: {
    hardhat: {
      chainId: 1337,
    },
    localhost: {
      url: 'http://127.0.0.1:8545',
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || '',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || '',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: 'USD',
  },
  etherscan: {
    apiKey: {
      arbitrumOne: process.env.ARBISCAN_API_KEY || '',
      arbitrumSepolia: process.env.ARBISCAN_API_KEY || '',
    },
  },
  mocha: {
    timeout: 40000,
  },
  typechain: {
    outDir: 'types',
    target: 'ethers-v6',
  },
};

export default config; 