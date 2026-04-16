# EVM Frontend Runtime Rule

This directory defines the runtime contract-config rule for EVM frontend consumers.

## Hard Rule

Frontend runtime must consume exactly one per-network release artifact.

Do not read core.json directly.

Do not merge multiple deployment files in the frontend.

## Required Read Paths

1. Preferred runtime artifact: frontend-config/networks/<network>.release.json
2. TypeScript frontend that imports this repo directly: frontend-config/networks/<network>.ts
3. Addresses: contracts
4. Version anchors: releaseId and generatedAt
5. Source tracking: sourceFiles
6. Registry/module binding lookup: contracts.<ContractName>.registryKey

## EVM Rule

Current EVM network modules in this repo must converge to the same shape:

1. frontend-config/networks/bnb-testnet.release.json
2. frontend-config/networks/bnb-testnet.ts
3. frontend-config/networks/arbitrum-sepolia.release.json
4. frontend-config/networks/arbitrum-sepolia.ts

TypeScript consumers should read DEPLOYMENT_METADATA and CONTRACT_ADDRESSES from the TS module.

Non-TypeScript consumers, config services, CI artifact distribution, and runtime-config loaders should prefer the release.json artifact.

## Migration Rule

If a network has not fully migrated its deployment pipeline yet, frontend runtime still reads one release artifact only.

The migration gap must be reflected in releaseId or sourceFiles, not patched by merging extra files in the frontend.