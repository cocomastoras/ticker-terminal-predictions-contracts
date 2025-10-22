import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable } from "hardhat/config";

const config: HardhatUserConfig = {
    plugins: [hardhatToolboxMochaEthersPlugin],
    solidity: {
        profiles: {
          default: {
            version: "0.8.28",
          },
          production: {
            version: "0.8.28",
            settings: {
              optimizer: {
                enabled: true,
                runs: 200,
              },
            },
          },
        },
    },
    networks: {
        hardhatMainnet: {
          type: "edr-simulated",
          chainType: "l1",
          accounts: {
            count: 100
          },
          mining: {
            auto: true,
            interval: 1000
          }
        },
        hardhatOp: {
          type: "edr-simulated",
          chainType: "op",
        },
        hardhatHype: {
          type: "edr-simulated",
          chainType: "l1",
          forking: {
            enabled: true,
            url: "https://rpc.hyperliquid.xyz/evm",
            blockNumber: 4034912
          },
        },
        sepolia: {
          type: "http",
          chainType: "l1",
          url: configVariable("SEPOLIA_RPC_URL"),
          accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
        },
        hyperliquidTestnet: {
          type: "http",
          chainType: "l1",
          url: "https://rpc.hyperliquid-testnet.xyz/evm",
          accounts: [],
        },
        hyperliquidMainnet: {
          type: "http",
          chainType: "l1",
          url: "https://rpc.hypurrscan.io",
          accounts: [],
        },
    },
    chainDescriptors: {
      999: {
          name: "hyperliquidMainnet",
          blockExplorers: {
              etherscan: {
                  name:"hyperevmscan",
                  url: "https://hyperevmscan.io/",
                  apiUrl: "https://api.etherscan.io/v2/api"
              }
          }
      }
    },
    verify: {
        etherscan: {
            apiKey: "",
        },
    }
};

export default config;
