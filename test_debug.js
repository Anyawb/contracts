const { ethers } = require('hardhat');
async function main() {
  const key1 = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
  const key2 = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL'));
  console.log('KEY_CM:', key1);
  console.log('KEY_ACCESS_CONTROL:', key2);
}
main();
