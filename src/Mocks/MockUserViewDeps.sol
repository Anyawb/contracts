// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockPositionViewBatch {
    struct Position {
        uint256 collateral;
        uint256 debt;
    }

    mapping(address => mapping(address => Position)) private _positions;

    function setPosition(address user, address asset, uint256 collateral, uint256 debt) external {
        _positions[user][asset] = Position({ collateral: collateral, debt: debt });
    }

    function getUserPosition(address user, address asset) external view returns (uint256 collateral, uint256 debt) {
        Position memory p = _positions[user][asset];
        return (p.collateral, p.debt);
    }

    function batchGetUserPositions(
        address[] calldata users,
        address[] calldata assets
    ) external view returns (uint256[] memory collaterals, uint256[] memory debts) {
        require(users.length == assets.length, "MockPositionViewBatch: length mismatch");
        uint256 len = users.length;
        collaterals = new uint256[](len);
        debts = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            Position memory p = _positions[users[i]][assets[i]];
            collaterals[i] = p.collateral;
            debts[i] = p.debt;
        }
    }
}

contract MockHealthViewBatch {
    struct HF {
        uint256 value;
        bool valid;
    }

    mapping(address => HF) private _hfs;

    function setHealth(address user, uint256 healthFactor, bool valid) external {
        _hfs[user] = HF({ value: healthFactor, valid: valid });
    }

    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid) {
        HF memory h = _hfs[user];
        return (h.value, h.valid);
    }

    function batchGetHealthFactors(address[] calldata users)
        external
        view
        returns (uint256[] memory healthFactors, bool[] memory valid)
    {
        uint256 len = users.length;
        healthFactors = new uint256[](len);
        valid = new bool[](len);
        for (uint256 i; i < len; ++i) {
            HF memory h = _hfs[users[i]];
            healthFactors[i] = h.value;
            valid[i] = h.valid;
        }
    }
}

contract MockPreviewView {
    struct BorrowResult {
        uint256 hf;
        uint256 ltv;
        uint256 maxBorrowable;
    }

    struct DepositResult {
        uint256 hf;
        bool ok;
    }

    struct RepayResult {
        uint256 hf;
        uint256 ltv;
    }

    struct WithdrawResult {
        uint256 hf;
        bool ok;
    }

    mapping(bytes32 => BorrowResult) public borrowResult;
    mapping(bytes32 => DepositResult) public depositResult;
    mapping(bytes32 => RepayResult) public repayResult;
    mapping(bytes32 => WithdrawResult) public withdrawResult;

    function setPreviewBorrow(
        address user,
        address asset,
        uint256 hf,
        uint256 ltv,
        uint256 maxBorrowable
    ) external {
        borrowResult[_key(user, asset)] = BorrowResult({ hf: hf, ltv: ltv, maxBorrowable: maxBorrowable });
    }

    function setPreviewDeposit(address user, address asset, uint256 hf, bool ok) external {
        depositResult[_key(user, asset)] = DepositResult({ hf: hf, ok: ok });
    }

    function setPreviewRepay(address user, address asset, uint256 hf, uint256 ltv) external {
        repayResult[_key(user, asset)] = RepayResult({ hf: hf, ltv: ltv });
    }

    function setPreviewWithdraw(address user, address asset, uint256 hf, bool ok) external {
        withdrawResult[_key(user, asset)] = WithdrawResult({ hf: hf, ok: ok });
    }

    function previewBorrow(
        address user,
        address asset,
        uint256,
        uint256,
        uint256
    ) external view returns (uint256 newHF, uint256 newLTV, uint256 maxBorrowable) {
        BorrowResult memory r = borrowResult[_key(user, asset)];
        return (r.hf, r.ltv, r.maxBorrowable);
    }

    function previewDeposit(
        address user,
        address asset,
        uint256
    ) external view returns (uint256 hfAfter, bool ok) {
        DepositResult memory r = depositResult[_key(user, asset)];
        return (r.hf, r.ok);
    }

    function previewRepay(address user, address asset, uint256) external view returns (uint256 newHF, uint256 newLTV) {
        RepayResult memory r = repayResult[_key(user, asset)];
        return (r.hf, r.ltv);
    }

    function previewWithdraw(
        address user,
        address asset,
        uint256
    ) external view returns (uint256 newHF, bool ok) {
        WithdrawResult memory r = withdrawResult[_key(user, asset)];
        return (r.hf, r.ok);
    }

    function _key(address user, address asset) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(user, asset));
    }
}

