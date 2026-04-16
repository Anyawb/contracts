import fs from "fs";
import path from "path";

import { JsonRpcProvider, ethers } from "ethers";

export type AddressMap = Record<string, string>;

export type ImplementationAuditStatus =
  | "exact-match"
  | "metadata-only-match"
  | "mismatch"
  | "no-local-artifact";

export type ImplementationAuditRow = {
  name: string;
  address: string;
  artifactPath?: string;
  isProxy: boolean;
  implementationAddress?: string;
  codeHash: string;
  normalizedCodeHash: string;
  artifactHash?: string;
  normalizedArtifactHash?: string;
  status: ImplementationAuditStatus;
};

export type ImplementationAuditReport = {
  audits: ImplementationAuditRow[];
  failures: string[];
  counts: Record<ImplementationAuditStatus, number>;
};

type ArtifactBytecodeEntry = {
  exactHash: string;
  normalizedHash: string;
  filePath: string;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function stripSolidityMetadata(bytecode: string) {
  if (!bytecode || bytecode === "0x" || bytecode.length < 6) {
    return bytecode;
  }

  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  if (hex.length < 4) {
    return bytecode;
  }

  const metadataLengthBytes = Number.parseInt(hex.slice(-4), 16);
  if (!Number.isFinite(metadataLengthBytes) || metadataLengthBytes <= 0) {
    return bytecode;
  }

  const metadataCharLength = (metadataLengthBytes + 2) * 2;
  if (metadataCharLength >= hex.length) {
    return bytecode;
  }

  return `0x${hex.slice(0, hex.length - metadataCharLength)}`;
}

function buildArtifactBytecodeIndex(artifactsDir: string) {
  const hashes = new Map<string, ArtifactBytecodeEntry[]>();
  const queue = [artifactsDir];

  const addHash = (name: string | undefined, entry: ArtifactBytecodeEntry) => {
    if (!name) return;
    const normalizedName = name.trim();
    if (!normalizedName) return;
    const list = hashes.get(normalizedName) ?? [];
    if (!list.some((candidate) => candidate.filePath === entry.filePath && candidate.exactHash === entry.exactHash)) {
      list.push(entry);
      hashes.set(normalizedName, list);
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

      try {
        const parsed = readJson<{ deployedBytecode?: string; contractName?: string }>(fullPath);
        const deployedBytecode = String(parsed.deployedBytecode ?? "0x");
        if (deployedBytecode === "0x") continue;

        const normalizedBytecode = stripSolidityMetadata(deployedBytecode);
        const record: ArtifactBytecodeEntry = {
          exactHash: ethers.keccak256(deployedBytecode),
          normalizedHash: ethers.keccak256(normalizedBytecode),
          filePath: fullPath,
        };
        const contractName = path.basename(entry.name, ".json");
        addHash(contractName, record);
        addHash(parsed.contractName, record);
      } catch {
      }
    }
  }

  return hashes;
}

export async function auditDeployedImplementations(params: {
  core: AddressMap;
  provider: JsonRpcProvider;
  artifactsDir: string;
  eip1967ImplementationSlot: string;
  noCodeAllowed?: Set<string>;
  artifactAliases?: Record<string, string[]>;
}): Promise<ImplementationAuditReport> {
  const artifactHashes = buildArtifactBytecodeIndex(params.artifactsDir);
  const audits: ImplementationAuditRow[] = [];
  const failures: string[] = [];
  const noCodeAllowed = params.noCodeAllowed ?? new Set<string>();

  const resolveCandidates = (name: string) => {
    const aliases = [name, ...(params.artifactAliases?.[name] ?? [])];
    const out: ArtifactBytecodeEntry[] = [];
    const seen = new Set<string>();

    for (const alias of aliases) {
      for (const candidate of artifactHashes.get(alias) ?? []) {
        const key = `${candidate.filePath}:${candidate.exactHash}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(candidate);
      }
    }

    return out;
  };

  for (const [name, address] of Object.entries(params.core)) {
    if (!ethers.isAddress(address)) continue;

    const runtimeCode = await params.provider.getCode(address);
    if (runtimeCode === "0x") {
      if (noCodeAllowed.has(name)) continue;
      failures.push(`${name}: no code at ${address}`);
      continue;
    }

    const implementationRaw = await params.provider.getStorage(address, params.eip1967ImplementationSlot);
    const implementationAddress = implementationRaw && implementationRaw !== "0x"
      ? ethers.getAddress(`0x${implementationRaw.slice(-40)}`)
      : undefined;
    const implementationCode = implementationAddress && implementationAddress !== ethers.ZeroAddress
      ? await params.provider.getCode(implementationAddress)
      : "0x";
    const isProxy = implementationCode !== "0x" && Math.max(0, (runtimeCode.length - 2) / 2) <= 400;
    const codeToCompare = isProxy ? implementationCode : runtimeCode;
    const normalizedCode = stripSolidityMetadata(codeToCompare);
    const codeHash = ethers.keccak256(codeToCompare);
    const normalizedCodeHash = ethers.keccak256(normalizedCode);
    const candidates = resolveCandidates(name);
    const exactMatch = candidates.find((candidate) => candidate.exactHash === codeHash);
    const normalizedMatch = exactMatch ?? candidates.find((candidate) => candidate.normalizedHash === normalizedCodeHash);

    if (candidates.length === 0) {
      audits.push({
        name,
        address,
        isProxy,
        implementationAddress,
        codeHash,
        normalizedCodeHash,
        status: "no-local-artifact",
      });
      failures.push(`${name}: local artifact not found for code hash audit`);
      continue;
    }

    const status: ImplementationAuditStatus = exactMatch
      ? "exact-match"
      : normalizedMatch
        ? "metadata-only-match"
        : "mismatch";

    audits.push({
      name,
      address,
      artifactPath: normalizedMatch?.filePath,
      isProxy,
      implementationAddress,
      codeHash,
      normalizedCodeHash,
      artifactHash: normalizedMatch?.exactHash,
      normalizedArtifactHash: normalizedMatch?.normalizedHash,
      status,
    });

    if (status === "mismatch") {
      failures.push(
        `${name}: ${isProxy ? "implementation" : "runtime"} hash ${codeHash} (normalized ${normalizedCodeHash}) does not match local artifact ${candidates[0].exactHash} (normalized ${candidates[0].normalizedHash})`,
      );
    }
  }

  const counts: Record<ImplementationAuditStatus, number> = {
    "exact-match": 0,
    "metadata-only-match": 0,
    mismatch: 0,
    "no-local-artifact": 0,
  };
  for (const audit of audits) {
    counts[audit.status] += 1;
  }

  return { audits, failures, counts };
}