/// @title <ContractName>
/// @notice <简要说明 | Brief description>
/// @dev 合约版本：v<version> | 作者：<author> | 审计状态：<audit status>
/// @custom:security-contact security@example.com

### 函数注释模板 / Function Comment Template

```solidity
/// @notice Brief summary for external users
/// @dev Developer note or detailed explanation
/// @param user The address of the caller
/// @param amount Amount to deposit
/// @return success Whether the operation succeeded
function deposit(address user, uint256 amount) external returns (bool);
```

> 可选自定义标签（示例）：
> - `@custom:version`: v1.0.0
> - `@custom:audit`: none / auditing / audited

---

**维护说明 / Maintenance Note**

1. **元信息字段**：请根据实际情况填写版本、作者、审计状态，可留空。
2. **多语言支持**：当前模板以中文为主，英文解释放在 `|` 之后，可自行调整。
3. **示例用法**：将上述头部注释复制到合约文件顶部，根据需要修改字段。 