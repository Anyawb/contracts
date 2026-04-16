import { runLiveRoleReadinessAudit } from './tools/live-role-readiness-audit';

void runLiveRoleReadinessAudit().catch((error) => {
	console.error("\n❌ settlement-role-bridge-local FAILED\n");
	console.error(error);
	process.exit(1);
});