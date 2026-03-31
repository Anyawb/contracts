import { sweepManagedFreshBorrowers } from "./_freshBorrowerManager";

async function main() {
  await sweepManagedFreshBorrowers();
}

main().catch((error) => {
  console.error("\n❌ sweep-fresh-borrowers FAILED\n");
  console.error(error);
  process.exit(1);
});