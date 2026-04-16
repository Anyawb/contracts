import path from "path";

import { network } from "hardhat";

function toKebabCase(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
}

function isLiveEntryLabel(label: string) {
  return /^(live|configure|fund|seed|sweep)-/.test(label);
}

export function resolveLiveScriptId(scriptFile: string) {
  const baseName = path.basename(scriptFile, path.extname(scriptFile));
  return normalizeLiveScriptId(baseName);
}

export function normalizeLiveScriptId(label: string) {
  const networkSuffix = `-${toKebabCase(network.name)}`;
  if (label.endsWith(networkSuffix)) {
    return label;
  }

  const rewritten = label.replace(/-(arbitrum-sepolia|bnb-testnet|localhost|hardhat)$/, networkSuffix);
  if (rewritten !== label) {
    return rewritten;
  }

  if (isLiveEntryLabel(label)) {
    return `${label}${networkSuffix}`;
  }

  return label;
}

export function logLiveScriptSuccess(scriptFile: string, status = "PASSED") {
  console.log(`\n✅ ${resolveLiveScriptId(scriptFile)} ${status}\n`);
}

export function logLiveScriptFailure(scriptFile: string, error?: unknown) {
  console.error(`\n❌ ${resolveLiveScriptId(scriptFile)} FAILED\n`);
  if (typeof error !== "undefined") {
    console.error(error);
  }
}
