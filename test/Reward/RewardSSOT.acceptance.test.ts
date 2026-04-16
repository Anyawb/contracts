import { expect } from 'chai';
import hardhat from 'hardhat';

import {
  REWARD_ON_LOAN_EVENT_BY_ORDER_FULL_SIGNATURE,
  selectorFromSignature
} from '../helpers/rewardSsot';

const { ethers } = hardhat;

describe('SSOT – Reward order-based entry (signature/selector)', function () {
  it('Order-based overload signature selector should match contract ABI', async function () {
    const RewardManager = await ethers.getContractFactory('RewardManager');

    const expected = selectorFromSignature(REWARD_ON_LOAN_EVENT_BY_ORDER_FULL_SIGNATURE);
    const fromAbi = RewardManager.interface.getFunction(REWARD_ON_LOAN_EVENT_BY_ORDER_FULL_SIGNATURE)!.selector;

    expect(fromAbi).to.equal(expected);
  });
});

