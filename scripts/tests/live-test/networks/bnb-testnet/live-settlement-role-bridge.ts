import { prepareBnbLiveEnv } from './_bootstrap';
import { runLiveRoleReadinessAudit } from '../../../tools/live-role-readiness-audit';

prepareBnbLiveEnv();

void runLiveRoleReadinessAudit().catch((error) => {
	console.error("\n❌ live-settlement-role-bridge FAILED\n");
	console.error(error);
	process.exit(1);
});