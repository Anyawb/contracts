// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { AmountIsZero, AmountMismatch, ZeroAddress } from "../errors/StandardErrors.sol";
import { RWAAssetNotAllowed } from "../errors/StandardErrors.sol";

import { IRWAPriceOracle } from "../interfaces/IRWAPriceOracle.sol";
import { IRWATokenRegistry } from "../interfaces/IRWATokenRegistry.sol";

/* =====================================================
 *                     Internal 库
 * ===================================================*/
/// @title TokenUtilsInternal
/// @notice 提供 ERC20/721/1155 通用拉币、余额差值验证等常用工具函数（仅供内部调用）。
library TokenUtilsInternal {
    /* -------------------------- 常量 -------------------------- */
    bytes4 private constant _ERC721_INTERFACE_ID = 0x80ac58cd;
    bytes4 private constant _ERC1155_INTERFACE_ID = 0xd9b67a26;

    /* --------------------------------------------------------- */
    /// @dev 返回指定 ERC20 token 在合约地址上的余额快照
    function _balanceOf(IERC20 token) internal view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice 在开始转账前调用，确保 `expectedAmount > 0`，否则 revert。
    /// @return 原样返回以便内联使用
    function preValidateAmount(uint256 expectedAmount) internal pure returns (uint256) {
        if (expectedAmount == 0) revert AmountIsZero();
        return expectedAmount;
    }

    /// @notice 在转账完成后验证实际收到数量是否与预期一致（仅适用 ERC20）。
    /// @param beforeBalance 转账前余额
    /// @param token         ERC20 token 地址
    /// @param expectedAmount 预期收到的数量
    function verifyTransferResult(
        uint256 beforeBalance,
        IERC20 token,
        uint256 expectedAmount
    ) internal view {
        uint256 afterBalance = token.balanceOf(address(this));
        uint256 actualAmount = afterBalance - beforeBalance;
        if (actualAmount != expectedAmount) revert AmountMismatch();
    }

    /* ==================== 新增功能 ==================== */

    /// @dev 通用拉币（ERC20 / ERC721 / ERC1155）到本合约。
    function _pullTokenUniversal(
        address token,
        address from,
        uint256 id,
        uint256 amount
    ) internal {
        // 0. 金额校验（对于 ERC721 可传入 1 作为占位）
        preValidateAmount(amount);

        if (_supportsInterface(token, _ERC721_INTERFACE_ID)) {
            // ERC721 —— 忽略 amount，默认 1
            IERC721(token).safeTransferFrom(from, address(this), id);
        } else if (_supportsInterface(token, _ERC1155_INTERFACE_ID)) {
            // ERC1155
            IERC1155(token).safeTransferFrom(from, address(this), id, amount, "");
        } else {
            // 默认按 ERC20 处理，兼容非标准实现
            _safeTransferFromERC20(token, from, address(this), amount);
        }
    }

    /// @dev 查询余额差值（目前仅针对 ERC20）
    function _getBalanceDelta(
        address token,
        address account,
        uint256 beforeBalance
    ) internal view returns (uint256) {
        uint256 afterBalance = IERC20(token).balanceOf(account);
        return afterBalance - beforeBalance;
    }

    /* ----------------- 内部工具函数 ----------------- */

    function _safeTransferFromERC20(
        address token,
        address from,
        address to,
        uint256 amount
    ) private {
        // 调用 IERC20 的 transferFrom；对返回值宽松处理，以兼容非标准实现
        try IERC20(token).transferFrom(from, to, amount) returns (bool ok) {
            require(ok, "ERC20_TRANSFER_FAILED");
        } catch {
            // 某些非标准 ERC20 不返回值，若执行成功即认为 OK
        }
    }

    /// @dev 尝试通过 ERC165 判断接口支持情况，失败则返回 false
    function _supportsInterface(address token, bytes4 interfaceId) private view returns (bool) {
        (bool success, bytes memory result) = token.staticcall(
            abi.encodeWithSelector(IERC165.supportsInterface.selector, interfaceId)
        );
        return (success && result.length >= 32 && abi.decode(result, (bool)));
    }
}

/* =====================================================
 *              External Facade 合约 (Ownable)
 * ===================================================*/
/// @title TokenUtils
/// @notice 提供托管式的 Token 工具入口，方便其他合约通过 delegate-less 方式复用。
contract TokenUtils is Ownable {
    using TokenUtilsInternal for *;

    // --- 外部依赖 ---
    address public priceOracle;
    address public tokenRegistry;

    event PriceOracleUpdated(address indexed newOracle);
    event TokenRegistryUpdated(address indexed newRegistry);

    constructor(address _priceOracle, address _tokenRegistry) {
        priceOracle = _priceOracle;
        tokenRegistry = _tokenRegistry;
    }

    /* ============ Admin ============ */

    function setPriceOracle(address _newOracle) external onlyOwner {
        if (_newOracle == address(0)) revert ZeroAddress();
        priceOracle = _newOracle;
        emit PriceOracleUpdated(_newOracle);
    }

    function setTokenRegistry(address _newRegistry) external onlyOwner {
        if (_newRegistry == address(0)) revert ZeroAddress();
        tokenRegistry = _newRegistry;
        emit TokenRegistryUpdated(_newRegistry);
    }

    /* ============ External Callables ============ */

    /// @notice 通用拉币到本合约
    function pullTokenUniversal(
        address token,
        address from,
        uint256 id,
        uint256 amount
    ) external {
        TokenUtilsInternal._pullTokenUniversal(token, from, id, amount);
    }

    /// @notice 余额差值查询（仅支持 ERC20）
    function getBalanceDelta(
        address token,
        address account,
        uint256 beforeBalance
    ) external view returns (uint256) {
        return TokenUtilsInternal._getBalanceDelta(token, account, beforeBalance);
    }

    /// @notice 查询 USD 价格（透传到 Oracle）
    function getPriceUSD(address token) external view returns (uint256 price, uint8 decimals) {
        if (priceOracle == address(0)) revert ZeroAddress();
        return IRWAPriceOracle(priceOracle).getPriceUSD(token);
    }

    /// @notice 校验 RWA 资产是否允许
    function validateAllowedRWA(address token) external view {
        if (tokenRegistry == address(0)) revert ZeroAddress();
        bool allowed = IRWATokenRegistry(tokenRegistry).isAllowed(token);
        if (!allowed) revert RWAAssetNotAllowed(token);
    }
} 