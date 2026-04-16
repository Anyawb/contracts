import "ethers";

declare module "ethers" {
  interface BaseContract {
    [key: string]: any;
  }

  interface Fragment {
    readonly name: string;
    readonly stateMutability: string;
  }
}

export {};