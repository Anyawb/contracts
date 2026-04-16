export interface DeployProfile {
  networkKey: string;
  networkSlug: string;
  entrypoints: {
    deployScriptFile: string;
  };
  inputs: {
    mockAssetPackSpecFile?: string;
    rwaPriceCatalogTemplateFile?: string;
  };
  outputs: {
    coreDeployFile: string;
    manifestFile: string;
    baselineFile?: string;
    mockSuiteDeployFile?: string;
    frontendConfigFile?: string;
    generatedAssetsFile?: string;
    generatedMockAssetPackFile?: string;
    exportedRwaPriceCatalogFile?: string;
  };
}

export interface LiveTestProfile {
  networkKey: string;
  networkSlug: string;
  deployOutputFile: string;
  assetsFile: string;
  mockAssetsFile?: string;
  sweepScriptFile: string;
  freshBorrowerSweepEnabled: boolean;
  liveUseMockAssetPack: boolean;
  livePriceMode: string;
  allowLiquidationManagerPause: boolean;
  allowDynamicFeeWrite: boolean;
  networkMaxAttempts: number;
  defaultTimeoutMs: number;
  retryCount: number;
  retryBackoffMs: number;
  scenarioAllowlist?: string[];
}
