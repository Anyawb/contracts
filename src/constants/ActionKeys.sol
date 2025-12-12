// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ActionKeys
/// @notice 系统标准化动作的 `bytes32` 哈希常量管理合约
/// @dev 统一管理动作标识符，避免散落硬编码；新增常量需保持向后兼容，勿随意改动已有取值
/// @dev 这些常量用于事件记录和权限验证，确保系统操作的一致性
/// @dev 所有常量都通过keccak256哈希生成，确保唯一性和不可变性
/// @dev 使用bytes32类型确保与权限系统的兼容性
/// @custom:security-contact security@example.com
library ActionKeys {
    // ============ 常量定义 ============
    /// @notice 动作Key总数常量
    /// @dev 避免硬编码，便于维护和扩展
    uint256 internal constant ACTION_KEY_COUNT = 44;

    // ============ 基础业务动作 Key ============
    /// @notice 存入抵押物操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("DEPOSIT")
    bytes32 public constant ACTION_DEPOSIT = keccak256("DEPOSIT");
    
    /// @notice 借款操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("BORROW")
    bytes32 public constant ACTION_BORROW = keccak256("BORROW");
    
    /// @notice 还款操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("REPAY")
    bytes32 public constant ACTION_REPAY = keccak256("REPAY");
    
    /// @notice 提取抵押物操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("WITHDRAW")
    bytes32 public constant ACTION_WITHDRAW = keccak256("WITHDRAW");

    /// @notice 订单创建专用权限（仅用于 createLoanOrder 鉴权）
    /// @dev 用于权限验证，不作为通用业务语义事件使用
    /// @dev 哈希值：keccak256("ORDER_CREATE")
    bytes32 public constant ACTION_ORDER_CREATE = keccak256("ORDER_CREATE");
    
    /// @notice 清算操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("LIQUIDATE")
    bytes32 public constant ACTION_LIQUIDATE = keccak256("LIQUIDATE");
    
    /// @notice 部分清算操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("LIQUIDATE_PARTIAL")
    bytes32 public constant ACTION_LIQUIDATE_PARTIAL = keccak256("LIQUIDATE_PARTIAL");

    /// @notice 没收保证金操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("LIQUIDATE_GUARANTEE")
    bytes32 public constant ACTION_LIQUIDATE_GUARANTEE = keccak256("LIQUIDATE_GUARANTEE");

    // ============ 奖励相关动作 Key ============
    /// @notice 领取奖励操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("CLAIM_REWARD")
    bytes32 public constant ACTION_CLAIM_REWARD = keccak256("CLAIM_REWARD");
    
    /// @notice 消费积分操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("CONSUME_POINTS")
    bytes32 public constant ACTION_CONSUME_POINTS = keccak256("CONSUME_POINTS");
    
    /// @notice 升级服务等级操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("UPGRADE_SERVICE")
    bytes32 public constant ACTION_UPGRADE_SERVICE = keccak256("UPGRADE_SERVICE");

    // ============ 系统管理动作 Key ============
    /// @notice 更新价格操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("UPDATE_PRICE")
    bytes32 public constant ACTION_UPDATE_PRICE = keccak256("UPDATE_PRICE");
    
    /// @notice 设置参数操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("SET_PARAMETER")
    bytes32 public constant ACTION_SET_PARAMETER = keccak256("SET_PARAMETER");
    
    /// @notice 升级模块操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("UPGRADE_MODULE")
    bytes32 public constant ACTION_UPGRADE_MODULE = keccak256("UPGRADE_MODULE");
    
    /// @notice 暂停系统操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("PAUSE_SYSTEM")
    bytes32 public constant ACTION_PAUSE_SYSTEM = keccak256("PAUSE_SYSTEM");
    
    /// @notice 恢复系统操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("UNPAUSE_SYSTEM")
    bytes32 public constant ACTION_UNPAUSE_SYSTEM = keccak256("UNPAUSE_SYSTEM");

    // ============ 治理动作 Key ============
    /// @notice 创建提案操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("CREATE_PROPOSAL")
    bytes32 public constant ACTION_CREATE_PROPOSAL = keccak256("CREATE_PROPOSAL");
    
    /// @notice 投票操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("VOTE")
    bytes32 public constant ACTION_VOTE = keccak256("VOTE");
    
    /// @notice 执行提案操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("EXECUTE_PROPOSAL")
    bytes32 public constant ACTION_EXECUTE_PROPOSAL = keccak256("EXECUTE_PROPOSAL");
    
    /// @notice 跨链投票操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("CROSS_CHAIN_VOTE")
    bytes32 public constant ACTION_CROSS_CHAIN_VOTE = keccak256("CROSS_CHAIN_VOTE");

    // ============ 权限管理动作 Key ============
    /// @notice 授予角色操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("GRANT_ROLE")
    bytes32 public constant ACTION_GRANT_ROLE = keccak256("GRANT_ROLE");
    
    /// @notice 撤销角色操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("REVOKE_ROLE")
    bytes32 public constant ACTION_REVOKE_ROLE = keccak256("REVOKE_ROLE");
    
    /// @notice 添加白名单操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("ADD_WHITELIST")
    bytes32 public constant ACTION_ADD_WHITELIST = keccak256("ADD_WHITELIST");
    
    /// @notice 移除白名单操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("REMOVE_WHITELIST")
    bytes32 public constant ACTION_REMOVE_WHITELIST = keccak256("REMOVE_WHITELIST");

    // ============ 批量操作动作 Key ============
    /// @notice 批量存入操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("BATCH_DEPOSIT")
    bytes32 public constant ACTION_BATCH_DEPOSIT = keccak256("BATCH_DEPOSIT");
    
    /// @notice 批量借款操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("BATCH_BORROW")
    bytes32 public constant ACTION_BATCH_BORROW = keccak256("BATCH_BORROW");
    
    /// @notice 批量还款操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("BATCH_REPAY")
    bytes32 public constant ACTION_BATCH_REPAY = keccak256("BATCH_REPAY");
    
    /// @notice 批量提取操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("BATCH_WITHDRAW")
    bytes32 public constant ACTION_BATCH_WITHDRAW = keccak256("BATCH_WITHDRAW");

    // ============ 测试网功能动作 Key ============
    /// @notice 测试网功能配置操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("TESTNET_CONFIG")
    bytes32 public constant ACTION_TESTNET_CONFIG = keccak256("TESTNET_CONFIG");
    
    /// @notice 测试网功能激活操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("TESTNET_ACTIVATE")
    bytes32 public constant ACTION_TESTNET_ACTIVATE = keccak256("TESTNET_ACTIVATE");
    
    /// @notice 测试网功能暂停操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("TESTNET_PAUSE")
    bytes32 public constant ACTION_TESTNET_PAUSE = keccak256("TESTNET_PAUSE");

    // ============ 数据查询权限动作 Key ============
    /// @notice 查看用户数据操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("VIEW_USER_DATA")
    bytes32 public constant ACTION_VIEW_USER_DATA = keccak256("VIEW_USER_DATA");
    
    /// @notice 查看风险数据操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("VIEW_RISK_DATA")
    bytes32 public constant ACTION_VIEW_RISK_DATA = keccak256("VIEW_RISK_DATA");
    
    /// @notice 查看系统数据操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("VIEW_SYSTEM_DATA")
    bytes32 public constant ACTION_VIEW_SYSTEM_DATA = keccak256("VIEW_SYSTEM_DATA");
    
    /// @notice 查看清算数据操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("VIEW_LIQUIDATION_DATA")
    bytes32 public constant ACTION_VIEW_LIQUIDATION_DATA = keccak256("VIEW_LIQUIDATION_DATA");
    
    /// @notice 查看缓存数据操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("VIEW_CACHE_DATA")
    bytes32 public constant ACTION_VIEW_CACHE_DATA = keccak256("VIEW_CACHE_DATA");
    
    /// @notice 管理事件历史操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("MANAGE_EVENT_HISTORY")
    bytes32 public constant ACTION_MANAGE_EVENT_HISTORY = keccak256("MANAGE_EVENT_HISTORY");
    
    /// @notice 查看价格数据操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("VIEW_PRICE_DATA")
    bytes32 public constant ACTION_VIEW_PRICE_DATA = keccak256("VIEW_PRICE_DATA");
    
    /// @notice 查看降级数据操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("VIEW_DEGRADATION_DATA")
    bytes32 public constant ACTION_VIEW_DEGRADATION_DATA = keccak256("VIEW_DEGRADATION_DATA");

    // ============ 管理员权限动作 Key ============
    /// @notice 管理员权限操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("ACTION_ADMIN")
    bytes32 public constant ACTION_ADMIN = keccak256("ACTION_ADMIN");
    
    /// @notice 设置升级管理员操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("SET_UPGRADE_ADMIN")
    bytes32 public constant ACTION_SET_UPGRADE_ADMIN = keccak256("SET_UPGRADE_ADMIN");
    
    /// @notice 紧急设置参数操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("EMERGENCY_SET_PARAMETER")
    bytes32 public constant ACTION_EMERGENCY_SET_PARAMETER = keccak256("EMERGENCY_SET_PARAMETER");
    
    /// @notice 修改用户数据操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("ACTION_MODIFY_USER_DATA")
    bytes32 public constant ACTION_MODIFY_USER_DATA = keccak256("ACTION_MODIFY_USER_DATA");
    
    /// @notice 查看系统状态操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("ACTION_VIEW_SYSTEM_STATUS")
    bytes32 public constant ACTION_VIEW_SYSTEM_STATUS = keccak256("ACTION_VIEW_SYSTEM_STATUS");

    // ============ 查询管理权限动作 Key ============
    /// @notice 查询管理权限操作的标识符
    /// @dev 用于事件记录和权限验证
    /// @dev 哈希值：keccak256("QUERY_MANAGER")
    bytes32 public constant ACTION_QUERY_MANAGER = keccak256("QUERY_MANAGER");

    /// @notice 检查是否为有效的动作Key
    /// @param key 待检查的动作Key
    /// @return 是否为有效动作Key
    function isValidActionKey(bytes32 key) internal pure returns (bool) {
        bytes32[ACTION_KEY_COUNT] memory keys = getAllActionKeysFixed();
        for (uint256 i = 0; i < ACTION_KEY_COUNT; i++) {
            if (keys[i] == key) {
                return true;
            }
        }
        return false;
    }

    /// @notice 获取动作Key的字符串名称
    /// @param key 动作Key
    /// @return 对应的字符串名称
    function getActionKeyString(bytes32 key) internal pure returns (string memory) {
        if (key == ACTION_DEPOSIT) return "deposit";
        if (key == ACTION_BORROW) return "borrow";
        if (key == ACTION_REPAY) return "repay";
        if (key == ACTION_WITHDRAW) return "withdraw";
        if (key == ACTION_ORDER_CREATE) return "orderCreate";
        if (key == ACTION_LIQUIDATE) return "liquidate";
        if (key == ACTION_LIQUIDATE_PARTIAL) return "liquidatePartial";
        if (key == ACTION_LIQUIDATE_GUARANTEE) return "liquidateGuarantee";
        if (key == ACTION_CLAIM_REWARD) return "claimReward";
        if (key == ACTION_CONSUME_POINTS) return "consumePoints";
        if (key == ACTION_UPGRADE_SERVICE) return "upgradeService";
        if (key == ACTION_UPDATE_PRICE) return "updatePrice";
        if (key == ACTION_SET_PARAMETER) return "setParameter";
        if (key == ACTION_UPGRADE_MODULE) return "upgradeModule";
        if (key == ACTION_PAUSE_SYSTEM) return "pauseSystem";
        if (key == ACTION_UNPAUSE_SYSTEM) return "unpauseSystem";
        if (key == ACTION_CREATE_PROPOSAL) return "createProposal";
        if (key == ACTION_VOTE) return "vote";
        if (key == ACTION_EXECUTE_PROPOSAL) return "executeProposal";
        if (key == ACTION_CROSS_CHAIN_VOTE) return "crossChainVote";
        if (key == ACTION_GRANT_ROLE) return "grantRole";
        if (key == ACTION_REVOKE_ROLE) return "revokeRole";
        if (key == ACTION_ADD_WHITELIST) return "addWhitelist";
        if (key == ACTION_REMOVE_WHITELIST) return "removeWhitelist";
        if (key == ACTION_BATCH_DEPOSIT) return "batchDeposit";
        if (key == ACTION_BATCH_BORROW) return "batchBorrow";
        if (key == ACTION_BATCH_REPAY) return "batchRepay";
        if (key == ACTION_BATCH_WITHDRAW) return "batchWithdraw";
        if (key == ACTION_TESTNET_CONFIG) return "testnetConfig";
        if (key == ACTION_TESTNET_ACTIVATE) return "testnetActivate";
        if (key == ACTION_TESTNET_PAUSE) return "testnetPause";
        if (key == ACTION_VIEW_USER_DATA) return "viewUserData";
        if (key == ACTION_VIEW_RISK_DATA) return "viewRiskData";
        if (key == ACTION_VIEW_SYSTEM_DATA) return "viewSystemData";
        if (key == ACTION_VIEW_LIQUIDATION_DATA) return "viewLiquidationData";
        if (key == ACTION_VIEW_CACHE_DATA) return "viewCacheData";
        if (key == ACTION_VIEW_PRICE_DATA) return "viewPriceData";
        if (key == ACTION_VIEW_DEGRADATION_DATA) return "viewDegradationData";
        if (key == ACTION_ADMIN) return "actionAdmin";
        if (key == ACTION_MODIFY_USER_DATA) return "actionModifyUserData";
        if (key == ACTION_SET_UPGRADE_ADMIN) return "setUpgradeAdmin";
        if (key == ACTION_EMERGENCY_SET_PARAMETER) return "emergencySetParameter";
        if (key == ACTION_VIEW_SYSTEM_STATUS) return "actionViewSystemStatus";
        if (key == ACTION_QUERY_MANAGER) return "queryManager";
        return "";
    }

    /// @notice 获取所有动作Key的固定数组
    /// @return 动作Key数组
    function getAllActionKeysFixed() internal pure returns (bytes32[ACTION_KEY_COUNT] memory) {
        bytes32[ACTION_KEY_COUNT] memory keys;
        keys[0] = ACTION_DEPOSIT;
        keys[1] = ACTION_BORROW;
        keys[2] = ACTION_REPAY;
        keys[3] = ACTION_WITHDRAW;
        keys[4] = ACTION_LIQUIDATE;
        keys[5] = ACTION_LIQUIDATE_PARTIAL;
        keys[6] = ACTION_LIQUIDATE_GUARANTEE;
        keys[7] = ACTION_CLAIM_REWARD;
        keys[8] = ACTION_CONSUME_POINTS;
        keys[9] = ACTION_UPGRADE_SERVICE;
        keys[10] = ACTION_UPDATE_PRICE;
        keys[11] = ACTION_SET_PARAMETER;
        keys[12] = ACTION_UPGRADE_MODULE;
        keys[13] = ACTION_PAUSE_SYSTEM;
        keys[14] = ACTION_UNPAUSE_SYSTEM;
        keys[15] = ACTION_CREATE_PROPOSAL;
        keys[16] = ACTION_VOTE;
        keys[17] = ACTION_EXECUTE_PROPOSAL;
        keys[18] = ACTION_CROSS_CHAIN_VOTE;
        keys[19] = ACTION_GRANT_ROLE;
        keys[20] = ACTION_REVOKE_ROLE;
        keys[21] = ACTION_ADD_WHITELIST;
        keys[22] = ACTION_REMOVE_WHITELIST;
        keys[23] = ACTION_BATCH_DEPOSIT;
        keys[24] = ACTION_BATCH_BORROW;
        keys[25] = ACTION_BATCH_REPAY;
        keys[26] = ACTION_BATCH_WITHDRAW;
        keys[27] = ACTION_TESTNET_CONFIG;
        keys[28] = ACTION_TESTNET_ACTIVATE;
        keys[29] = ACTION_TESTNET_PAUSE;
        keys[30] = ACTION_VIEW_USER_DATA;
        keys[31] = ACTION_VIEW_RISK_DATA;
        keys[32] = ACTION_VIEW_SYSTEM_DATA;
        keys[33] = ACTION_VIEW_LIQUIDATION_DATA;
        keys[34] = ACTION_VIEW_CACHE_DATA;
        keys[35] = ACTION_VIEW_PRICE_DATA;
        keys[36] = ACTION_VIEW_DEGRADATION_DATA;
        keys[37] = ACTION_ADMIN;
        keys[38] = ACTION_SET_UPGRADE_ADMIN;
        keys[39] = ACTION_EMERGENCY_SET_PARAMETER;
        keys[40] = ACTION_MODIFY_USER_DATA;
        keys[41] = ACTION_VIEW_SYSTEM_STATUS;
        keys[42] = ACTION_QUERY_MANAGER;
        keys[43] = ACTION_ORDER_CREATE;
        return keys;
    }
} 