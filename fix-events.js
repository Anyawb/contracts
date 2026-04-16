const fs = require('fs');
const file = 'docs/Offchain-View-Consumer-Retry-Audit-Design.md';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
`- \`CacheUpdateFailed(user, asset, viewAddr, collateral, debt, reason)\`
- \`HealthPushFailed(user, healthView, totalCollateral, totalDebt, reason)\`（如存在）`,
`- \`CacheUpdateFailed(user, asset, viewAddr, collateral, debt, reason)\`
- \`CacheUpdateFailedWithContext(user, asset, requestId, viewAddr, collateral, debt, reason, seq, nextVersion)\`
- \`HealthPushFailed(user, healthView, totalCollateral, totalDebt, reason)\``
);

fs.writeFileSync(file, content);
