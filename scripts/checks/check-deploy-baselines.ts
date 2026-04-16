import fs from "fs";
import path from "path";

import { ethers } from "ethers";

import { deployProfiles } from "../config/profiles/deploy";

type BaselineContractRecord = {
  address?: string;
  isProxy?: boolean;
  implementationAddress?: string | null;
  buildInfoFile?: string | null;
};

type DeployBaselineArtifact = {
  network?: string;
  chainId?: number;
  releaseId?: string;
  generatedAt?: string;
  registry?: string;
  sourceFiles?: Record<string, string>;
  git?: {
    commit?: string | null;
  };
  compilers?: Record<string, unknown>;
  contracts?: Record<string, BaselineContractRecord>;
};

type ManifestArtifact = {
  deployOutputFile?: string;
  baselineFile?: string | null;
};

type FrontendReleaseArtifact = {
  sourceFiles?: {
    baselineFile?: string | null;
    deployOutputFile?: string;
  };
};

const ROOT = process.cwd();

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function ensure(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function resolveFrontendReleaseFile(frontendConfigFile: string) {
  if (!frontendConfigFile.endsWith(".ts")) {
    return null;
  }
  return frontendConfigFile.replace(/\.ts$/, ".release.json");
}

function validateBaselineFile(params: {
  networkName: string;
  coreFile: string;
  baselineFile: string;
  manifestFile: string;
  frontendReleaseFile: string | null;
}) {
  const baselinePath = path.join(ROOT, params.baselineFile);
  const manifestPath = path.join(ROOT, params.manifestFile);
  const frontendReleasePath = params.frontendReleaseFile ? path.join(ROOT, params.frontendReleaseFile) : null;

  ensure(fs.existsSync(baselinePath), `${params.networkName}: missing baseline file ${params.baselineFile}`);
  const baseline = readJson<DeployBaselineArtifact>(baselinePath);

  ensure(typeof baseline.network === "string" && baseline.network.length > 0, `${params.networkName}: baseline.network is missing`);
  ensure(typeof baseline.chainId === "number" && Number.isFinite(baseline.chainId), `${params.networkName}: baseline.chainId is missing`);
  ensure(typeof baseline.releaseId === "string" && baseline.releaseId.length > 0, `${params.networkName}: baseline.releaseId is missing`);
  ensure(typeof baseline.generatedAt === "string" && baseline.generatedAt.length > 0, `${params.networkName}: baseline.generatedAt is missing`);
  ensure(ethers.isAddress(String(baseline.registry ?? "")), `${params.networkName}: baseline.registry is missing or invalid`);
  ensure(typeof baseline.git?.commit === "string" && baseline.git.commit.length > 0, `${params.networkName}: baseline.git.commit is missing`);
  ensure(baseline.sourceFiles?.deployOutputFile === params.coreFile, `${params.networkName}: baseline deployOutputFile does not match ${params.coreFile}`);
  ensure(baseline.sourceFiles?.baselineFile === params.baselineFile, `${params.networkName}: baseline sourceFiles.baselineFile does not match ${params.baselineFile}`);
  ensure(baseline.sourceFiles?.manifestFile === params.manifestFile, `${params.networkName}: baseline sourceFiles.manifestFile does not match ${params.manifestFile}`);

  const compilers = baseline.compilers ?? {};
  ensure(Object.keys(compilers).length > 0, `${params.networkName}: baseline.compilers is empty`);

  const contracts = baseline.contracts ?? {};
  ensure(Object.keys(contracts).length > 0, `${params.networkName}: baseline.contracts is empty`);
  let foundBuildInfoAnchor = false;
  for (const [name, contract] of Object.entries(contracts)) {
    ensure(ethers.isAddress(String(contract.address ?? "")), `${params.networkName}: baseline contract ${name} has invalid address`);
    if (contract.buildInfoFile) {
      foundBuildInfoAnchor = true;
    }
    if (contract.isProxy) {
      ensure(
        typeof contract.implementationAddress === "string" && ethers.isAddress(contract.implementationAddress),
        `${params.networkName}: proxy contract ${name} is missing implementationAddress`,
      );
    }
  }
  ensure(foundBuildInfoAnchor, `${params.networkName}: baseline contracts are missing build-info anchors`);

  if (fs.existsSync(manifestPath)) {
    const manifest = readJson<ManifestArtifact>(manifestPath);
    ensure(manifest.deployOutputFile === params.coreFile, `${params.networkName}: manifest deployOutputFile does not match ${params.coreFile}`);
    ensure(manifest.baselineFile === params.baselineFile, `${params.networkName}: manifest baselineFile does not match ${params.baselineFile}`);
  }

  if (frontendReleasePath && fs.existsSync(frontendReleasePath)) {
    const frontendRelease = readJson<FrontendReleaseArtifact>(frontendReleasePath);
    ensure(
      frontendRelease.sourceFiles?.deployOutputFile === params.coreFile,
      `${params.networkName}: frontend release deployOutputFile does not match ${params.coreFile}`,
    );
    ensure(
      frontendRelease.sourceFiles?.baselineFile === params.baselineFile,
      `${params.networkName}: frontend release baselineFile does not match ${params.baselineFile}`,
    );
  }
}

function main() {
  for (const [networkName, profile] of Object.entries(deployProfiles)) {
    const coreFileRaw = profile.outputs.coreDeployFile;
    const baselineFileRaw = profile.outputs.baselineFile;
    const manifestFileRaw = profile.outputs.manifestFile;
    const frontendConfigFileRaw = profile.outputs.frontendConfigFile;

    if (!coreFileRaw) {
      throw new Error(`${networkName}: missing profile coreDeployFile output`);
    }
    if (!baselineFileRaw) {
      throw new Error(`${networkName}: missing profile baselineFile output`);
    }
    if (!manifestFileRaw) {
      throw new Error(`${networkName}: missing profile manifestFile output`);
    }
    if (!frontendConfigFileRaw) {
      throw new Error(`${networkName}: missing profile frontendConfigFile output`);
    }

    const coreFile = coreFileRaw;
    const baselineFile = baselineFileRaw;
    const manifestFile = manifestFileRaw;
    const frontendConfigFile = frontendConfigFileRaw;
    const frontendReleaseFile = resolveFrontendReleaseFile(frontendConfigFile);
    const corePath = path.join(ROOT, coreFile);
    const baselinePath = path.join(ROOT, baselineFile);

    if (!fs.existsSync(corePath) && !fs.existsSync(baselinePath)) {
      continue;
    }

    ensure(fs.existsSync(corePath), `${networkName}: missing core deploy file ${coreFile}`);
    validateBaselineFile({
      networkName,
      coreFile,
      baselineFile,
      manifestFile,
      frontendReleaseFile,
    });

    console.log(`OK ${networkName} baseline=${baselineFile}`);
  }
}

main();