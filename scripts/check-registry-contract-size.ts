import { artifacts } from "hardhat";

type SizeRow = {
  name: string;
  deployedBytes: number;
  creationBytes: number;
};

function byteLen(hex: string): number {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Math.floor(h.length / 2);
}

async function getSize(name: string): Promise<SizeRow> {
  const a = await artifacts.readArtifact(name);
  return {
    name,
    deployedBytes: byteLen(a.deployedBytecode),
    creationBytes: byteLen(a.bytecode),
  };
}

function fmt(bytes: number): string {
  return `${bytes.toString().padStart(6)} bytes (${(bytes / 1024).toFixed(2)} KB)`;
}

async function main() {
  // EIP-170: deployed/runtime code size limit.
  const DEPLOYED_LIMIT = 24_576;
  // EIP-3860: initcode limit (creation bytecode + constructor args); leaving here as a reference.
  const INITCODE_LIMIT = 49_152;

  const contracts = [
    "Registry",
    "RegistryDynamicModuleKey",
    // Existing registry view module (Vault/view layer)
    "src/Vault/view/modules/RegistryView.sol:RegistryView",
  ];

  const rows: SizeRow[] = [];
  for (const c of contracts) {
    try {
      rows.push(await getSize(c));
    } catch (e: any) {
      console.log(`${c}: Failed - ${e?.message ?? String(e)}`);
    }
  }

  console.log(`\n=== Registry / RegistryView Contract Size Report ===`);
  console.log(`Deployed (runtime) limit: ${DEPLOYED_LIMIT} bytes (EIP-170)`);
  console.log(`Initcode (creation) reference limit: ${INITCODE_LIMIT} bytes (EIP-3860, excludes constructor args here)`);

  console.log(`\n${"Contract".padEnd(45)}  ${"Deployed".padEnd(22)}  ${"Usage".padEnd(10)}  ${"Creation".padEnd(22)}`);
  for (const r of rows) {
    const usage = `${((r.deployedBytes / DEPLOYED_LIMIT) * 100).toFixed(2)}%`;
    console.log(
      `${r.name.padEnd(45)}  ${fmt(r.deployedBytes).padEnd(22)}  ${usage.padEnd(10)}  ${fmt(r.creationBytes).padEnd(22)}`
    );
  }

  const sorted = [...rows].sort((a, b) => b.deployedBytes - a.deployedBytes);
  console.log(`\n=== Largest (by deployed/runtime bytecode) ===`);
  for (const r of sorted.slice(0, 10)) {
    console.log(`${r.name.padEnd(45)}  ${r.deployedBytes} bytes`);
  }

  const registry = rows.find((r) => r.name === "Registry");
  if (registry) {
    console.log(`\n=== Registry Summary ===`);
    if (registry.deployedBytes >= DEPLOYED_LIMIT) {
      console.log(`❌ Registry exceeds EIP-170 deployed bytecode limit.`);
    } else if (registry.deployedBytes > 20_000) {
      console.log(`⚠️  Registry is large (>20KB). Avoid adding more features; consider offloading optional helpers.`);
    } else {
      console.log(`✅ Registry deployed bytecode is within reasonable limits.`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

