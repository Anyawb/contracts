// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { UserView } from "./UserView.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";

/// @title PreviewView
/// @notice Thin wrapper that forwards preview calls to UserView for front-end convenience.
/// @dev Provides read-only preview helpers that delegate to the canonical UserView implementation.
///      No state is stored in this contract except the Registry pointer.
/// @custom:security-contact security@example.com
contract PreviewView is Initializable, UUPSUpgradeable {
    address private _registryAddr;

    modifier onlyValidRegistry(){ if(_registryAddr==address(0)) revert ZeroAddress(); _; }

    /**
     * @notice 初始化合约并设置 Registry 地址。
     * @dev 只能调用一次；调用者需要在部署后立即执行以防止零地址攻击。
     * @param initialRegistryAddr Registry 合约地址。
     */
    function initialize(address initialRegistryAddr) external initializer {
        if(initialRegistryAddr==address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // === Direct proxy helpers ===
    /**
     * @notice 预估用户存入抵押物后的健康因子。
     * @dev 只读方法，所有计算均委托给 UserView。
     * @param user   用户地址。
     * @param asset  抵押资产地址。
     * @param amount 存入数量。
     * @return hfAfter 存入后的健康因子 (bps)。
     * @return ok      存入后健康因子是否高于最低安全阈值。
     */
    function previewDeposit(address user,address asset,uint256 amount) external view onlyValidRegistry returns(uint256 hfAfter,bool ok){
        return _uv().previewDeposit(user,asset,amount);
    }
    /**
     * @notice 预估用户提取抵押物后的健康因子。
     * @dev 只读方法，所有计算均委托给 UserView。
     * @param user   用户地址。
     * @param asset  抵押资产地址。
     * @param amount 提取数量。
     * @return hfAfter 提取后的健康因子 (bps)。
     * @return ok      是否仍满足最低健康因子要求。
     */
    function previewWithdraw(address user,address asset,uint256 amount) external view onlyValidRegistry returns(uint256 hfAfter,bool ok){
        return _uv().previewWithdraw(user,asset,amount);
    }
    /**
     * @notice 预估用户借款操作后的风险指标。
     * @dev 通过 UserView 计算新的健康因子、LTV 及最大可借额度。
     * @param user           用户地址。
     * @param asset          借款资产地址。
     * @param collateralIn   当前抵押数量。
     * @param collateralAdd  新增抵押数量。
     * @param borrowAmount   本次欲借款数量。
     * @return newHF         借款后的健康因子 (bps)。
     * @return newLTV        借款后的贷款价值比 (bps)。
     * @return maxBorrowable 在保持安全阈值下还能借出的最大额度。
     */
    function previewBorrow(address user,address asset,uint256 collateralIn,uint256 collateralAdd,uint256 borrowAmount) external view onlyValidRegistry returns(uint256 newHF,uint256 newLTV,uint256 maxBorrowable){
        return _uv().previewBorrow(user,asset,collateralIn,collateralAdd,borrowAmount);
    }
    /**
     * @notice 预估用户还款后的风险指标。
     * @param user   用户地址。
     * @param asset  资产地址。
     * @param amount 还款数量。
     * @return newHF  还款后的健康因子 (bps)。
     * @return newLTV 还款后的贷款价值比 (bps)。
     */
    function previewRepay(address user,address asset,uint256 amount) external view onlyValidRegistry returns(uint256 newHF,uint256 newLTV){
        return _uv().previewRepay(user,asset,amount);
    }

    // === Internal ===
    /** @dev 从 Registry 获取 UserView 实例（内部辅助函数）。 */
    function _uv() internal view returns (UserView){ return UserView(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_USER_VIEW)); }

    // === UUPS ===
    /**
     * @dev UUPS 升级授权钩子。
     *      仅当调用者拥有 ACTION_ADMIN 角色且新实现地址不为零时允许升级。
     * @param newImplementation 新实现合约地址。
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        address acm=Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(ActionKeys.ACTION_ADMIN,msg.sender);
        if(newImplementation==address(0)) revert ZeroAddress();
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){return _registryAddr;}
} 