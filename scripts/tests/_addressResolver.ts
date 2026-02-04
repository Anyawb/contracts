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

function loadLocalAddressMap(): AddressMap {
  const p = path.join(__dirname, "..", "deployments", "localhost.json");
  if (!existsSync(p)) return {};
  const json = loadJson(p) as Record<string, unknown>;
  const out: AddressMap = {};
  for (const [k, v] of Object.entries(json)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function loadDeploymentsAddressMap(networkName: string): AddressMap {
  const slug = networkName === "arbitrumSepolia" ? "arbitrum-sepolia" : networkName;
  const p = path.join(__dirname, "..", "..", "deployments", `addresses.${slug}.json`);
  if (!existsSync(p)) return {};
  const json = loadJson(p) as Record<string, unknown>;
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

export function loadAddressMap(networkName: string): AddressMap {
  if (networkName === "localhost") return loadLocalAddressMap();
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
