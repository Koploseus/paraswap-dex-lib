import dotenv from 'dotenv';
dotenv.config();

import { ContractMethod, Network, SwapSide } from '../../constants';
import { generateConfig } from '../../config';
import { newTestE2E } from '../../../tests/utils-e2e';
import { TenderlySimulator } from '../../../tests/tenderly-simulation';

jest.setTimeout(1000 * 60 * 3);

describe('AirSwap E2E', () => {
  const dexKey = 'AirSwap';
  const network = Network.SEPOLIA;
  const config = generateConfig(network);

  const USER_ADDRESS = '0x1D693a4425bf7eD10FE7775E2b65b072019FFceb';
  const TenderlySimCtor = TenderlySimulator as unknown as {
    DEFAULT_OWNER: string;
  };
  const originalOwner = TenderlySimCtor.DEFAULT_OWNER;
  TenderlySimCtor.DEFAULT_OWNER = USER_ADDRESS;

  afterAll(async () => {
    TenderlySimCtor.DEFAULT_OWNER = originalOwner;
    // Give time for async cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  // Forwarder dummy maker tokens on Sepolia
  const tokenA = {
    address: '0x20aaebad8c7c6ffb6fdaa5a622c399561562beea',
    decimals: 6,
  };
  const tokenB = {
    address: '0xf450ef4f268eaf2d3d8f9ed0354852e255a5eaef',
    decimals: 6,
  };

  // Forwarder minimum is 1 token (6 decimals). Request 10 tokens so chunked sampling stays >= 1.
  const amount = '10000000';
  const sleepMs = 7000;

  it('SELL tokenA -> tokenB', async () => {
    await newTestE2E({
      config,
      srcToken: tokenA,
      destToken: tokenB,
      senderAddress: USER_ADDRESS,
      _amount: amount,
      swapSide: SwapSide.SELL,
      dexKeys: dexKey,
      contractMethod: ContractMethod.swapExactAmountIn,
      network,
      sleepMs,
    });
  });

  it('BUY tokenA -> tokenB', async () => {
    await newTestE2E({
      config,
      srcToken: tokenB,
      destToken: tokenA,
      senderAddress: USER_ADDRESS,
      _amount: amount,
      swapSide: SwapSide.BUY,
      dexKeys: dexKey,
      contractMethod: ContractMethod.swapExactAmountOut,
      network,
      sleepMs,
    });
  });
});
