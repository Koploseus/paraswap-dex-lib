import { DexConfigMap } from '../../types';
import { Network } from '../../constants';
import { AirSwapDeployment } from './types';

// AirSwap Forwarder Configuration
const AirSwap: Record<number, AirSwapDeployment> = {
  [Network.SEPOLIA]: {
    swapERC20Address: '0xD82E10B9A4107939e55fCCa9B53A9ede6CF2fC46',
    forwarderUrl: 'https://forwarder.airswap.xyz/jsonrpc',
    forwarderHealthUrl: 'https://forwarder.airswap.xyz/health',
    domainVersion: '4.3',
    domainName: 'SWAP_ERC20',
  },
};

export const AirSwapConfig: DexConfigMap<AirSwapDeployment> = {
  AirSwap,
};
