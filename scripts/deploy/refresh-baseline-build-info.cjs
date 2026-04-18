const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const DEPLOYMENTS_DIR = path.join(ROOT, "scripts", "deployments");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");

function toRepoPath(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function collectBaselineFiles(dirPath, out = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectBaselineFiles(fullPath, out);
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name === "baseline.json" || entry.name.endsWith(".baseline.json"))
    ) {
      out.push(fullPath);
    }
  }
  return out.sort((left, right) => left.localeCompare(right));
}

function buildArtifactIndex() {
  const index = new Map();
  const queue = [ARTIFACTS_DIR];

  const add = (key, filePath) => {
    if (!key || !key.trim()) return;
    const normalized = key.trim();
    const existing = index.get(normalized) || [];
    if (!existing.includes(filePath)) {
      existing.push(filePath);
      index.set(normalized, existing);
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
        const parsed = readJson(fullPath);
        add(parsed.contractName, fullPath);
      } catch (error) {
        void error;
      }
    }
  }

  return index;
}

function resolveArtifactPath(contractName, artifactPathRaw, artifactIndex) {
  const artifactPath = path.join(ROOT, artifactPathRaw);
  if (fs.existsSync(artifactPath)) {
    return artifactPath;
  }

  const fileBase = path.basename(artifactPathRaw, ".json");
  const sourceDirBase = path.basename(path.dirname(artifactPathRaw));
  const candidates = [...new Set([...(artifactIndex.get(contractName) || []), ...(artifactIndex.get(fileBase) || [])])];

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length > 1) {
    const preferred = candidates.filter((candidate) => {
      return candidate.endsWith(`/${fileBase}.json`) || candidate.includes(`/${sourceDirBase}/`);
    });
    if (preferred.length === 1) {
      return preferred[0];
    }
    if (preferred.length > 1) {
      throw new Error(
        `Ambiguous artifact candidates for ${contractName}: ${preferred.map((item) => toRepoPath(item)).join(", ")}`,
      );
    }
  }

  throw new Error(`Missing artifact file for ${contractName}: ${artifactPathRaw}`);
}

function readCompilerSummary(artifactPath) {
  const dbgPath = artifactPath.replace(/\.json$/, ".dbg.json");
  if (!fs.existsSync(dbgPath)) {
    throw new Error(`Missing artifact dbg file: ${toRepoPath(dbgPath)}`);
  }

  const dbg = readJson(dbgPath);
  if (!dbg.buildInfo) {
    throw new Error(`Artifact dbg missing buildInfo pointer: ${toRepoPath(dbgPath)}`);
  }

  const buildInfoPath = path.resolve(path.dirname(dbgPath), dbg.buildInfo);
  if (!fs.existsSync(buildInfoPath)) {
    throw new Error(`Missing build-info file referenced by ${toRepoPath(dbgPath)}: ${toRepoPath(buildInfoPath)}`);
  }

  const buildInfo = readJson(buildInfoPath);
  const settings = buildInfo.input && buildInfo.input.settings ? buildInfo.input.settings : {};
  return {
    buildInfoFile: toRepoPath(buildInfoPath),
    solcVersion: buildInfo.solcVersion || null,
    solcLongVersion: buildInfo.solcLongVersion || null,
    optimizerEnabled: typeof settings.optimizer?.enabled === "boolean" ? settings.optimizer.enabled : null,
    optimizerRuns: typeof settings.optimizer?.runs === "number" ? settings.optimizer.runs : null,
    viaIR: typeof settings.viaIR === "boolean" ? settings.viaIR : null,
    evmVersion: typeof settings.evmVersion === "string" ? settings.evmVersion : null,
    bytecodeHash: typeof settings.metadata?.bytecodeHash === "string" ? settings.metadata.bytecodeHash : null,
  };
}

function refreshBaselineFile(filePath, artifactIndex) {
  const baseline = readJson(filePath);
  const contracts = baseline.contracts || {};
  const compilerCatalog = new Map();
  let updatedContracts = 0;

  for (const [contractName, contract] of Object.entries(contracts)) {
    if (!contract.artifactPath) {
      contract.buildInfoFile = null;
      contract.compilerKey = null;
      continue;
    }

    const artifactPath = resolveArtifactPath(contractName, contract.artifactPath, artifactIndex);
    const compiler = readCompilerSummary(artifactPath);
    contract.buildInfoFile = compiler.buildInfoFile;
    contract.compilerKey = compiler.buildInfoFile;
    compilerCatalog.set(compiler.buildInfoFile, compiler);
    updatedContracts += 1;
  }

  baseline.compilers = Object.fromEntries(
    [...compilerCatalog.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  writeJson(filePath, baseline);

  return {
    filePath: toRepoPath(filePath),
    releaseId: baseline.releaseId || null,
    updatedContracts,
    compilerCount: compilerCatalog.size,
  };
}

function main() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    throw new Error(`Missing deployments directory: ${toRepoPath(DEPLOYMENTS_DIR)}`);
  }

  const baselineFiles = collectBaselineFiles(DEPLOYMENTS_DIR);
  if (baselineFiles.length === 0) {
    throw new Error(`No baseline files found under ${toRepoPath(DEPLOYMENTS_DIR)}`);
  }

  const artifactIndex = buildArtifactIndex();
  const results = baselineFiles.map((filePath) => {
    console.log(`refreshing ${toRepoPath(filePath)}`);
    return refreshBaselineFile(filePath, artifactIndex);
  });
  for (const result of results) {
    console.log(
      `refreshed ${result.filePath} releaseId=${result.releaseId || "<none>"} ` +
        `contracts=${result.updatedContracts} compilers=${result.compilerCount}`,
    );
  }
  console.log(`refreshed baseline files: ${results.length}`);
}

main();