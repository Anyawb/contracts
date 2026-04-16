import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { JsonRpcProvider, ethers } from "ethers";

import {
  stripSolidityMetadata,
  type AddressMap,
  type ImplementationAuditReport,
  type ImplementationAuditRow,
} from "./evm-implementation-audit";

export type BuildInfoCompilerSummary = {
  buildInfoFile: string;
  solcVersion: string | null;
  solcLongVersion: string | null;
  optimizerEnabled: boolean | null;
  optimizerRuns: number | null;
  viaIR: boolean | null;
  evmVersion: string | null;
  bytecodeHash: string | null;
};

export type BaselineContractRecord = {
  address: string;
  registryKey: string | null;
  isProxy: boolean;
  implementationAddress: string | null;
  artifactPath: string | null;
  buildInfoFile: string | null;
  compilerKey: string | null;
  codeHash: string | null;
  normalizedCodeHash: string | null;
  artifactHash: string | null;
  normalizedArtifactHash: string | null;
  auditStatus: string | null;
};

export type DeployBaselineArtifact = {
  network: string;
  chainId: number;
  releaseId: string;
  generatedAt: string;
  registry: string;
  sourceFiles: Record<string, string>;
  git: {
    commit: string | null;
    branch: string | null;
    isDirty: boolean;
    statusShort: string[];
  };
  compilers: Record<string, BuildInfoCompilerSummary>;
  contracts: Record<string, BaselineContractRecord>;
  audit: {
    implementation: {
      counts: Record<string, number>;
      failureCount: number;
      status: "passed" | "failed";
    };
  };
};

type LocalArtifactMatch = {
  artifactPath: string | null;
  compiler: BuildInfoCompilerSummary | null;
  artifactHash: string | null;
  normalizedArtifactHash: string | null;
  auditStatus: string | null;
};

type InspectContractParams = {
  name: string;
  address: string;
  rootDir: string;
  provider?: JsonRpcProvider;
  eip1967ImplementationSlot?: string;
  noCodeAllowed: Set<string>;
  artifactIndex: Map<string, string[]>;
  artifactAliases: Record<string, string[]>;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runGit(rootDir: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout || "").trim();
}

function collectGitSnapshot(rootDir: string) {
  const statusRaw = runGit(rootDir, ["status", "--short"]) ?? "";
  return {
    commit: runGit(rootDir, ["rev-parse", "HEAD"]),
    branch: runGit(rootDir, ["branch", "--show-current"]),
    isDirty: statusRaw.length > 0,
    statusShort: statusRaw.length > 0 ? statusRaw.split(/\r?\n/).filter(Boolean) : [],
  };
}

function buildArtifactPathIndex(artifactsDir: string) {
  const index = new Map<string, string[]>();
  const queue = [artifactsDir];

  const add = (name: string | undefined, filePath: string) => {
    if (!name) return;
    const key = name.trim();
    if (!key) return;
    const list = index.get(key) ?? [];
    if (!list.includes(filePath)) {
      list.push(filePath);
      index.set(key, list);
    }
  };

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".dbg.json")) {
        continue;
      }

      add(path.basename(entry.name, ".json"), fullPath);
      try {
        const parsed = readJson<{ contractName?: string }>(fullPath);
        add(parsed.contractName, fullPath);
      } catch {
      }
    }
  }

  return index;
}

function readBuildInfoCompilerSummary(rootDir: string, artifactPath: string): BuildInfoCompilerSummary | null {
  const dbgPath = artifactPath.replace(/\.json$/, ".dbg.json");
  if (!fs.existsSync(dbgPath)) return null;

  try {
    const dbg = readJson<{ buildInfo?: string }>(dbgPath);
    if (!dbg.buildInfo) return null;
    const buildInfoPath = path.resolve(path.dirname(dbgPath), dbg.buildInfo);
    if (!fs.existsSync(buildInfoPath)) return null;
    const buildInfo = readJson<{
      solcVersion?: string;
      solcLongVersion?: string;
      input?: {
        settings?: {
          optimizer?: { enabled?: boolean; runs?: number };
          viaIR?: boolean;
          evmVersion?: string;
          metadata?: { bytecodeHash?: string };
        };
      };
    }>(buildInfoPath);
    const settings = buildInfo.input?.settings;
    return {
      buildInfoFile: path.relative(rootDir, buildInfoPath),
      solcVersion: buildInfo.solcVersion ?? null,
      solcLongVersion: buildInfo.solcLongVersion ?? null,
      optimizerEnabled: typeof settings?.optimizer?.enabled === "boolean" ? settings.optimizer.enabled : null,
      optimizerRuns: typeof settings?.optimizer?.runs === "number" ? settings.optimizer.runs : null,
      viaIR: typeof settings?.viaIR === "boolean" ? settings.viaIR : null,
      evmVersion: typeof settings?.evmVersion === "string" ? settings.evmVersion : null,
      bytecodeHash: typeof settings?.metadata?.bytecodeHash === "string" ? settings.metadata.bytecodeHash : null,
    };
  } catch {
    return null;
  }
}

function resolveArtifactCandidates(
  artifactIndex: Map<string, string[]>,
  name: string,
  aliases: Record<string, string[]>,
) {
  return [name, ...(aliases[name] ?? [])].flatMap((candidate) => artifactIndex.get(candidate) ?? []);
}

function matchLocalArtifact(rootDir: string, artifactCandidates: string[], runtimeBytecode: string): LocalArtifactMatch {
  if (artifactCandidates.length === 0) {
    return {
      artifactPath: null,
      compiler: null,
      artifactHash: null,
      normalizedArtifactHash: null,
      auditStatus: "no-local-artifact",
    };
  }

  const normalizedCode = stripSolidityMetadata(runtimeBytecode);
  const codeHash = ethers.keccak256(runtimeBytecode);
  const normalizedCodeHash = ethers.keccak256(normalizedCode);

  let fallbackArtifactPath = artifactCandidates[0] ?? null;
  let matchedArtifactPath: string | null = null;
  let matchedArtifactHash: string | null = null;
  let matchedNormalizedArtifactHash: string | null = null;
  let matchedStatus: string | null = null;

  for (const artifactPath of artifactCandidates) {
    try {
      const artifact = readJson<{ deployedBytecode?: string }>(artifactPath);
      const deployedBytecode = String(artifact.deployedBytecode ?? "0x");
      if (deployedBytecode === "0x") continue;
      const exactHash = ethers.keccak256(deployedBytecode);
      const normalizedHash = ethers.keccak256(stripSolidityMetadata(deployedBytecode));
      if (!matchedArtifactPath) {
        fallbackArtifactPath = artifactPath;
        matchedArtifactHash = exactHash;
        matchedNormalizedArtifactHash = normalizedHash;
      }
      if (exactHash === codeHash) {
        matchedArtifactPath = artifactPath;
        matchedArtifactHash = exactHash;
        matchedNormalizedArtifactHash = normalizedHash;
        matchedStatus = "exact-match";
        break;
      }
      if (!matchedStatus && normalizedHash === normalizedCodeHash) {
        matchedArtifactPath = artifactPath;
        matchedArtifactHash = exactHash;
        matchedNormalizedArtifactHash = normalizedHash;
        matchedStatus = "metadata-only-match";
      }
    } catch {
    }
  }

  const artifactPath = matchedArtifactPath ?? fallbackArtifactPath;
  return {
    artifactPath: artifactPath ? path.relative(rootDir, artifactPath) : null,
    compiler: artifactPath ? readBuildInfoCompilerSummary(rootDir, artifactPath) : null,
    artifactHash: matchedArtifactHash,
    normalizedArtifactHash: matchedNormalizedArtifactHash,
    auditStatus: matchedStatus ?? "mismatch",
  };
}

async function inspectContract(params: InspectContractParams) {
  const artifactCandidates = resolveArtifactCandidates(params.artifactIndex, params.name, params.artifactAliases);
  if (!params.provider) {
    const artifactPath = artifactCandidates[0] ?? null;
    const compiler = artifactPath ? readBuildInfoCompilerSummary(params.rootDir, artifactPath) : null;
    return {
      isProxy: false,
      implementationAddress: null,
      codeHash: null,
      normalizedCodeHash: null,
      artifactPath: artifactPath ? path.relative(params.rootDir, artifactPath) : null,
      buildInfoFile: compiler?.buildInfoFile ?? null,
      compilerKey: compiler?.buildInfoFile ?? null,
      artifactHash: null,
      normalizedArtifactHash: null,
      auditStatus: artifactPath ? null : "no-local-artifact",
      compiler,
    };
  }

  const runtimeCode = await params.provider.getCode(params.address);
  if (runtimeCode === "0x") {
    if (!params.noCodeAllowed.has(params.name)) {
      throw new Error(`Missing code at ${params.name} (${params.address}) while building deploy baseline`);
    }

    const artifactPath = artifactCandidates[0] ?? null;
    const compiler = artifactPath ? readBuildInfoCompilerSummary(params.rootDir, artifactPath) : null;
    return {
      isProxy: false,
      implementationAddress: null,
      codeHash: null,
      normalizedCodeHash: null,
      artifactPath: artifactPath ? path.relative(params.rootDir, artifactPath) : null,
      buildInfoFile: compiler?.buildInfoFile ?? null,
      compilerKey: compiler?.buildInfoFile ?? null,
      artifactHash: null,
      normalizedArtifactHash: null,
      auditStatus: null,
      compiler,
    };
  }

  const implementationRaw = params.eip1967ImplementationSlot
    ? await params.provider.getStorage(params.address, params.eip1967ImplementationSlot)
    : "0x";
  const implementationAddress = implementationRaw && implementationRaw !== "0x"
    ? ethers.getAddress(`0x${implementationRaw.slice(-40)}`)
    : null;
  const implementationCode = implementationAddress && implementationAddress !== ethers.ZeroAddress
    ? await params.provider.getCode(implementationAddress)
    : "0x";
  const isProxy = implementationCode !== "0x" && Math.max(0, (runtimeCode.length - 2) / 2) <= 400;
  const codeToCompare = isProxy ? implementationCode : runtimeCode;
  const localMatch = matchLocalArtifact(params.rootDir, artifactCandidates, codeToCompare);

  return {
    isProxy,
    implementationAddress: isProxy ? implementationAddress : null,
    codeHash: ethers.keccak256(codeToCompare),
    normalizedCodeHash: ethers.keccak256(stripSolidityMetadata(codeToCompare)),
    artifactPath: localMatch.artifactPath,
    buildInfoFile: localMatch.compiler?.buildInfoFile ?? null,
    compilerKey: localMatch.compiler?.buildInfoFile ?? null,
    artifactHash: localMatch.artifactHash,
    normalizedArtifactHash: localMatch.normalizedArtifactHash,
    auditStatus: localMatch.auditStatus,
    compiler: localMatch.compiler,
  };
}

export async function buildDeployBaseline(params: {
  rootDir: string;
  artifactsDir: string;
  network: string;
  chainId: number;
  releaseId: string;
  generatedAt: string;
  registry: string;
  core: AddressMap;
  sourceFiles: Record<string, string>;
  nameToKey: Record<string, string>;
  provider?: JsonRpcProvider;
  eip1967ImplementationSlot?: string;
  noCodeAllowed?: Set<string>;
  artifactAliases?: Record<string, string[]>;
  implementationAudit?: ImplementationAuditReport;
}): Promise<DeployBaselineArtifact> {
  const artifactIndex = buildArtifactPathIndex(params.artifactsDir);
  const compilerCatalog = new Map<string, BuildInfoCompilerSummary>();
  const auditByName = new Map<string, ImplementationAuditRow>((params.implementationAudit?.audits ?? []).map((audit) => [audit.name, audit]));
  const noCodeAllowed = params.noCodeAllowed ?? new Set<string>();
  const artifactAliases = params.artifactAliases ?? {};

  const contracts = Object.fromEntries(
    await Promise.all(
      Object.entries(params.core).map(async ([name, address]) => {
        const precomputedAudit = auditByName.get(name);
        if (precomputedAudit) {
          const compiler = precomputedAudit.artifactPath
            ? readBuildInfoCompilerSummary(params.rootDir, path.join(params.rootDir, precomputedAudit.artifactPath))
            : null;
          if (compiler) {
            compilerCatalog.set(compiler.buildInfoFile, compiler);
          }

          return [
            name,
            {
              address,
              registryKey: params.nameToKey[name] ?? null,
              isProxy: precomputedAudit.isProxy ?? false,
              implementationAddress: precomputedAudit.implementationAddress ?? null,
              artifactPath: precomputedAudit.artifactPath ?? null,
              buildInfoFile: compiler?.buildInfoFile ?? null,
              compilerKey: compiler?.buildInfoFile ?? null,
              codeHash: precomputedAudit.codeHash ?? null,
              normalizedCodeHash: precomputedAudit.normalizedCodeHash ?? null,
              artifactHash: precomputedAudit.artifactHash ?? null,
              normalizedArtifactHash: precomputedAudit.normalizedArtifactHash ?? null,
              auditStatus: precomputedAudit.status ?? null,
            } satisfies BaselineContractRecord,
          ] as const;
        }

        const inspected = await inspectContract({
          name,
          address,
          rootDir: params.rootDir,
          provider: params.provider,
          eip1967ImplementationSlot: params.eip1967ImplementationSlot,
          noCodeAllowed,
          artifactIndex,
          artifactAliases,
        });
        if (inspected.compiler) {
          compilerCatalog.set(inspected.compiler.buildInfoFile, inspected.compiler);
        }

        return [
          name,
          {
            address,
            registryKey: params.nameToKey[name] ?? null,
            isProxy: inspected.isProxy,
            implementationAddress: inspected.implementationAddress,
            artifactPath: inspected.artifactPath,
            buildInfoFile: inspected.buildInfoFile,
            compilerKey: inspected.compilerKey,
            codeHash: inspected.codeHash,
            normalizedCodeHash: inspected.normalizedCodeHash,
            artifactHash: inspected.artifactHash,
            normalizedArtifactHash: inspected.normalizedArtifactHash,
            auditStatus: inspected.auditStatus,
          } satisfies BaselineContractRecord,
        ] as const;
      }),
    ),
  );

  const counts = params.implementationAudit?.counts ?? {
    "exact-match": 0,
    "metadata-only-match": 0,
    mismatch: 0,
    "no-local-artifact": 0,
  };
  const derivedFailureCount = Object.values(contracts).reduce((sum, contract) => {
    return sum + (contract.auditStatus === "mismatch" || contract.auditStatus === "no-local-artifact" ? 1 : 0);
  }, 0);
  const failureCount = params.implementationAudit?.failures.length ?? derivedFailureCount;

  if (!params.implementationAudit) {
    for (const contract of Object.values(contracts)) {
      if (contract.auditStatus === "exact-match") counts["exact-match"] += 1;
      if (contract.auditStatus === "metadata-only-match") counts["metadata-only-match"] += 1;
      if (contract.auditStatus === "mismatch") counts.mismatch += 1;
      if (contract.auditStatus === "no-local-artifact") counts["no-local-artifact"] += 1;
    }
  }

  return {
    network: params.network,
    chainId: params.chainId,
    releaseId: params.releaseId,
    generatedAt: params.generatedAt,
    registry: params.registry,
    sourceFiles: params.sourceFiles,
    git: collectGitSnapshot(params.rootDir),
    compilers: Object.fromEntries([...compilerCatalog.entries()].sort(([left], [right]) => left.localeCompare(right))),
    contracts,
    audit: {
      implementation: {
        counts,
        failureCount,
        status: failureCount > 0 ? "failed" : "passed",
      },
    },
  };
}

export async function writeDeployBaseline(params: {
  filePath: string;
  rootDir: string;
  artifactsDir: string;
  network: string;
  chainId: number;
  releaseId: string;
  generatedAt: string;
  registry: string;
  core: AddressMap;
  sourceFiles: Record<string, string>;
  nameToKey: Record<string, string>;
  provider?: JsonRpcProvider;
  eip1967ImplementationSlot?: string;
  noCodeAllowed?: Set<string>;
  artifactAliases?: Record<string, string[]>;
  implementationAudit?: ImplementationAuditReport;
}) {
  const baseline = await buildDeployBaseline(params);
  writeJson(params.filePath, baseline);
  return baseline;
}