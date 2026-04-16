export type FrontendReleaseContractEntry = Readonly<{
  address: string;
  registryKey: string | null;
}>;

export type FrontendReleaseSourceFiles = Readonly<Record<string, string>>;

export type FrontendReleaseArtifact = Readonly<{
  network: string;
  chainId: number | string;
  releaseId: string;
  generatedAt: string;
  sourceFiles: FrontendReleaseSourceFiles;
  contracts: Readonly<Record<string, FrontendReleaseContractEntry>>;
  registry?: string;
}>;

export const FRONTEND_MULTI_CHAIN_RUNTIME_RULE = {
  version: '2026-04-13',
  scope: 'evm-only',
  hardRules: [
    'Frontend runtime must never read core.json directly.',
    'Frontend runtime must never merge multiple deployment files on its own.',
    'Frontend runtime must consume exactly one per-network release artifact.',
    'Preferred runtime artifact is frontend-config/networks/<network>.release.json.',
    'TypeScript apps that import this repo directly should read frontend-config/networks/<network>.ts.',
    'Addresses are read from contracts.',
    'Version anchors are read from releaseId and generatedAt.',
    'Source tracking is read from sourceFiles.',
    'Registry/module binding lookup is read from contracts.<ContractName>.registryKey.',
  ],
  evm: {
    preferredArtifactPattern: 'frontend-config/networks/<network>.release.json',
    tsModulePattern: 'frontend-config/networks/<network>.ts',
    addressField: 'contracts',
    versionFields: ['releaseId', 'generatedAt'],
    sourceField: 'sourceFiles',
  },
} as const;