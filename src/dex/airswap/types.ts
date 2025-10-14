import { Address } from '../../types';
import { OrderERC20 } from '@airswap/utils';

// Forwarder-based deployment config
export type AirSwapDeployment = {
  swapERC20Address: Address;
  forwarderUrl: string;
  forwarderHealthUrl: string;
  domainVersion: string;
  domainName: string;
};

// Order response data structure
export type AirSwapOrderResponse = {
  order?: OrderERC20;
};
