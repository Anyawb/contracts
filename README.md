# Smart Contracts Repository

This is a standalone repository containing all smart contracts for the RWA Lending Platform.

## Overview

This repository contains:
- **Solidity Contracts**: All smart contract source files (`.sol`)
- **Tests**: Comprehensive test suite (`.test.ts`, `.spec.ts`)
- **Scripts**: Deployment and utility scripts
- **ABI Files**: Compiled contract ABIs
- **Documentation**: Contract documentation and guides
- **Configuration**: Hardhat, TypeScript, and other configuration files

## Structure

```
contracts/
├── access/              # Access control contracts
├── constants/           # Constants and configuration
├── core/               # Core business logic contracts
├── errors/             # Custom error definitions
├── Governance/         # Governance contracts
├── interfaces/         # Contract interfaces
├── libraries/          # Solidity libraries
├── Mocks/              # Mock contracts for testing
├── monitor/            # Monitoring and degradation contracts
├── registry/           # Registry contracts
├── Reward/             # Reward system contracts
├── strategies/         # Strategy contracts
├── Token/              # Token contracts
├── utils/              # Utility contracts
├── Vault/              # Vault contracts
├── scripts/            # Deployment and utility scripts
├── test/               # Test files
├── abi/                # Compiled ABIs
├── deployments/        # Deployment addresses and configs
├── docs/               # Documentation
├── frontend-config/    # Frontend integration configs
├── hardhat-node/       # Hardhat node configuration
└── src/                # Additional source files
```

## Getting Started

### Prerequisites

- Node.js (v18+)
- npm or yarn
- Hardhat

### Installation

```bash
npm install
```

### Configuration

1. Copy `.env.template` to `.env`
2. Fill in your environment variables (RPC URLs, private keys, etc.)

### Compile Contracts

```bash
npm run compile
```

### Run Tests

```bash
npm test
```

### Deploy to Local Network

```bash
npm run node
npm run deploy:localhost
```

## Available Scripts

- `npm run compile` - Compile contracts
- `npm run test` - Run tests
- `npm run node` - Start local Hardhat node
- `npm run deploy:localhost` - Deploy to local network
- `npm run coverage` - Generate test coverage
- `npm run lint:sol` - Lint Solidity files
- `npm run format:sol` - Format Solidity files
- `npm run docs` - Generate documentation

## Networks

- **localhost**: Local development network
- **arbitrum**: Arbitrum One mainnet
- **arbitrumSepolia**: Arbitrum Sepolia testnet

## License

MIT
