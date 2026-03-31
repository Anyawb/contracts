import { existsSync, readFileSync } from "fs";
import path from "path";

export type AddressMap = Record<string, string>;

export function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return defaultValue;
}

export function envStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim();
  return v.length ? v : undefined;
}

function normalizeAddress(v?: string): string | undefined {
  if (!v) return undefined;
  const out = v.trim();
  return out.length ? out : undefined;
}

function loadJson(p: string): any {
  const raw = readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function jsonToAddressMap(json: Record<string, unknown>): AddressMap {
  const out: AddressMap = {};
  const contracts = (json as any)?.contracts;
  if (contracts && typeof contracts === "object") {
    for (const [name, data] of Object.entries(contracts)) {
      const addr = (data as any)?.address;
      if (typeof addr === "string" && addr.length) out[name] = addr;
    }
    return out;
  }

  for (const [k, v] of Object.entries(json)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function loadLocalAddressMap(): AddressMap {
  const p = path.join(__dirname, "..", "deployments", "localhost.json");
  if (!existsSync(p)) return {};
  const json = loadJson(p) as Record<string, unknown>;
  return jsonToAddressMap(json);
}

function loadDeploymentsAddressMap(networkName: string): AddressMap {
  const slug = networkName === "arbitrumSepolia" ? "arbitrum-sepolia" : networkName;
  const candidates = [
    path.join(__dirname, "..", "deployments", `${slug}.json`),
    path.join(__dirname, "..", "..", "deployments", `addresses.${slug}.json`),
  ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const json = loadJson(p) as Record<string, unknown>;
      const out = jsonToAddressMap(json);
      if (Object.keys(out).length > 0) return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[addressResolver] ignore invalid address file: ${p} (${msg})`);
    }
  }

  return {};
}

function loadPreferredDeploymentsAddressMap(networkName: string): AddressMap {
  const slug = networkName === "arbitrumSepolia" ? "arbitrum-sepolia" : networkName;
  const explicitDeployOutput = envStr("DEPLOY_OUTPUT_FILE");
  const candidates = explicitDeployOutput
    ? [
        path.isAbsolute(explicitDeployOutput)
          ? explicitDeployOutput
          : path.join(__dirname, "..", "deployments", explicitDeployOutput),
      ]
    : [
        path.join(__dirname, "..", "deployments", `${slug}.mock-suite.json`),
        path.join(__dirname, "..", "deployments", `${slug}.json`),
        path.join(__dirname, "..", "..", "deployments", `addresses.${slug}.json`),
      ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const json = loadJson(p) as Record<string, unknown>;
      const out = jsonToAddressMap(json);
      if (Object.keys(out).length > 0) return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[addressResolver] ignore invalid preferred address file: ${p} (${msg})`);
    }
  }

  return {};
}

export function loadAddressMap(networkName: string, options?: { preferMockSuite?: boolean }): AddressMap {
  if (networkName === "localhost") return loadLocalAddressMap();
  if (options?.preferMockSuite) {
    const preferred = loadPreferredDeploymentsAddressMap(networkName);
    if (Object.keys(preferred).length > 0) {
      return preferred;
    }
  }
  return loadDeploymentsAddressMap(networkName);
}

export function resolveAddress(opts: {
  name: string;
  map: AddressMap;
  envVar?: string;
  required?: boolean;
}): string {
  const envVar = opts.envVar ?? `${opts.name.toUpperCase()}_ADDRESS`;
  const fromEnv = normalizeAddress(process.env[envVar]);
  if (fromEnv) return fromEnv;
  const fromMap = normalizeAddress(opts.map[opts.name]);
  if (fromMap) return fromMap;
  if (opts.required === false) return "";
  throw new Error(`Missing address for ${opts.name}. Provide ${envVar} or populate deployments file.`);
}
