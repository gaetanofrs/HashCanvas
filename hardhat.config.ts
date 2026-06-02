import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

/**
 * HashCanvas — Permissioned EVM Ledger (Enterprise Ethereum target).
 * Solidity 0.8.24, EVM "paris" target, optimizer enabled (WP2 §3.1.3).
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "paris",
    },
  },
  mocha: {
    timeout: 120_000,
  },
  gasReporter: {
    enabled: Boolean(process.env.REPORT_GAS),
    currency: "USD",
    showMethodSig: true,
  },
};

export default config;
