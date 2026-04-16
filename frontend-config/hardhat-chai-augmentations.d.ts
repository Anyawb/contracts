import "hardhat/types/runtime";

declare module "hardhat" {
  export const ethers: any;
  export const upgrades: any;
}

declare module "hardhat/types/runtime" {
  interface HardhatRuntimeEnvironment {
    ethers: any;
    upgrades: any;
  }
}

declare global {
  export namespace Chai {
    interface Assertion {
      emit(contract: any, eventName?: string): Assertion;
      withArgs(...args: any[]): Assertion;
      reverted: Promise<any>;
      revertedWith(...args: any[]): Assertion;
      revertedWithCustomError(...args: any[]): Assertion;
    }
  }
}

export {};