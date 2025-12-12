// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LiquidationRiskLib} from "../../liquidation/libraries/LiquidationRiskLib.sol";
import {LiquidationTypes} from "../../liquidation/types/LiquidationTypes.sol";
import {ILiquidationRiskManager} from "../../../interfaces/ILiquidationRiskManager.sol";
import {Registry} from "../../../registry/Registry.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ViewInterfaceLibrary} from "../../../libraries/ViewInterfaceLibrary.sol";

/**
 * @title LiquidationRiskView
 * @dev 清算风险视图合约 - 提供清算风险相关的只读查询功能
 * @notice 该合约作为清算风险管理器的视图层，提供批量查询和健康因子计算功能
 * @author Easifi Protocol
 */
contract LiquidationRiskView {
    /// @dev 注册表合约地址
    address public registryAddrVar;

    /**
     * @dev 构造函数
     * @param _registryAddr 注册表合约地址
     */
    constructor(address _registryAddr) {
        registryAddrVar = _registryAddr;
    }

    /**
     * @dev 获取清算风险管理器实例
     * @return ILiquidationRiskManager 清算风险管理器接口实例
     */
    function _rm() internal view returns (ILiquidationRiskManager) {
        address rm = ViewInterfaceLibrary.resolveModuleView(registryAddrVar, ModuleKeys.KEY_RM);
        return ILiquidationRiskManager(rm);
    }
    /**
     * @dev 批量计算健康因子
     * @param collaterals 抵押品价值数组
     * @param debts 债务价值数组
     * @return healthFactors 健康因子数组
     * @notice 健康因子 = 抵押品价值 / 债务价值，值越高表示风险越低
     */
    function batchCalculateHealthFactors(
        uint256[] calldata collaterals,
        uint256[] calldata debts
    ) external pure returns (uint256[] memory healthFactors) {
        uint256 len = collaterals.length;
        require(len == debts.length, "len");
        healthFactors = new uint256[](len);
        for (uint256 i = 0; i < len;) {
            healthFactors[i] = LiquidationRiskLib.calculateHealthFactor(collaterals[i], debts[i]);
            unchecked { ++i; }
        }
    }

    /**
     * @dev 获取用户健康因子缓存信息（包含区块号）
     * @param user 用户地址
     * @return healthFactor 健康因子值
     * @return timestamp 缓存时间戳
     * @return blockNumber 当前区块号
     * @notice 如果健康因子为0，返回全零值
     */
    function getHealthFactorCacheWithBlock(address user)
        external
        view
        returns (uint256 healthFactor, uint256 timestamp, uint256 blockNumber)
    {
        (uint256 hf, uint256 ts) = _rm().getHealthFactorCache(user);
        if (hf == 0) {
            return (0, 0, 0);
        }
        return (hf, ts, block.number);
    }

    // ============ Manager view proxies ============
    /**
     * @dev 检查用户是否可被清算
     * @param user 用户地址
     * @return bool 是否可被清算
     */
    function isLiquidatable(address user) external view returns (bool) {
        return _rm().isLiquidatable(user);
    }

    /**
     * @dev 检查用户在特定资产下的清算状态
     * @param user 用户地址
     * @param collateral 抵押品价值
     * @param debt 债务价值
     * @param asset 资产地址
     * @return bool 是否可被清算
     */
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view returns (bool) {
        return _rm().isLiquidatable(user, collateral, debt, asset);
    }

    /**
     * @dev 获取用户清算风险评分
     * @param user 用户地址
     * @return uint256 清算风险评分
     * @notice 评分越高表示风险越大
     */
    function getLiquidationRiskScore(address user) external view returns (uint256) {
        return _rm().getLiquidationRiskScore(user);
    }

    /**
     * @dev 获取用户健康因子
     * @param user 用户地址
     * @return uint256 健康因子值
     */
    function getUserHealthFactor(address user) external view returns (uint256) {
        return _rm().getUserHealthFactor(user);
    }

    /**
     * @dev 批量检查用户是否可被清算
     * @param users 用户地址数组
     * @return bool[] 清算状态数组
     */
    function batchIsLiquidatable(address[] calldata users) external view returns (bool[] memory) {
        return _rm().batchIsLiquidatable(users);
    }

    /**
     * @dev 批量获取用户健康因子
     * @param users 用户地址数组
     * @return uint256[] 健康因子数组
     */
    function batchGetUserHealthFactors(address[] calldata users) external view returns (uint256[] memory) {
        return _rm().batchGetUserHealthFactors(users);
    }

    /**
     * @dev 批量获取用户清算风险评分
     * @param users 用户地址数组
     * @return uint256[] 清算风险评分数组
     */
    function batchGetLiquidationRiskScores(address[] calldata users) external view returns (uint256[] memory) {
        return _rm().batchGetLiquidationRiskScores(users);
    }

    /**
     * @dev 获取清算阈值
     * @return uint256 清算阈值
     * @notice 当健康因子低于此阈值时，用户可被清算
     */
    function getLiquidationThreshold() external view returns (uint256) {
        return _rm().getLiquidationThreshold();
    }

    /**
     * @dev 获取最小健康因子
     * @return uint256 最小健康因子值
     * @notice 系统要求的最低健康因子水平
     */
    function getMinHealthFactor() external view returns (uint256) {
        return _rm().getMinHealthFactor();
    }

    /**
     * @dev 获取用户健康因子缓存
     * @param user 用户地址
     * @return healthFactor 健康因子值
     * @return timestamp 缓存时间戳
     */
    function getHealthFactorCache(address user) external view returns (uint256 healthFactor, uint256 timestamp) {
        return _rm().getHealthFactorCache(user);
    }

    // 可选的管理器暴露的重复功能（如果存在）
    // 根据指南保持别名最小化；避免重复非核心获取器
}


