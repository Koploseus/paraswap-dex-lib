import dotenv from 'dotenv';
dotenv.config();

import https from 'https';
import { DummyDexHelper } from '../../dex-helper';
import { Network, SwapSide } from '../../constants';
import { AirSwap, MIN_EXPIRY } from './airswap';
import { checkPoolPrices, sleep } from '../../../tests/utils';
import { AirSwapConfig } from './config';
import { ForwarderClient } from './forwarder-client';
import { Token } from '../../types';

const dexKey = 'AirSwap';
describe('AirSwap', function () {
  describe('Sepolia', () => {
    const network = Network.SEPOLIA;
    let dexHelper: DummyDexHelper;

    const forwarderTokens: { signer: Token; sender: Token } = {
      signer: {
        address: '0x20aaebad8c7c6ffb6fdaa5a622c399561562beea',
        decimals: 6,
      },
      sender: {
        address: '0xf450ef4f268eaf2d3d8f9ed0354852e255a5eaef',
        decimals: 6,
      },
    };

    let originalSetTimeout: typeof setTimeout;
    const activeTimeouts = new Set<NodeJS.Timeout>();
    let getBlockNumberMock: jest.SpiedFunction<
      typeof DummyDexHelper.prototype.web3Provider.eth.getBlockNumber
    >;

    const atomic = (value: number) => BigInt(value) * 1_000_000n;
    const amountsForSell = [
      0n,
      atomic(1),
      atomic(2),
      atomic(3),
      atomic(4),
      atomic(5),
    ];

    let blockNumber: number;
    let airswap: AirSwap;

    beforeAll(async () => {
      originalSetTimeout = global.setTimeout;
      global.setTimeout = ((
        handler: (...args: any[]) => void,
        timeout?: number,
        ...args: any[]
      ) => {
        const handle = originalSetTimeout(
          handler,
          timeout,
          ...args,
        ) as NodeJS.Timeout;
        activeTimeouts.add(handle);
        return handle;
      }) as typeof setTimeout;

      dexHelper = new DummyDexHelper(network);

      getBlockNumberMock = jest
        .spyOn(dexHelper.web3Provider.eth, 'getBlockNumber')
        .mockResolvedValue(0 as any);

      blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
      airswap = new AirSwap(network, dexKey, dexHelper);
      await airswap.initializePricing(blockNumber);
      await sleep(5000); // Wait for forwarder pricing to be fetched
    });

    afterAll(() => {
      airswap?.releaseResources();
      getBlockNumberMock?.mockRestore();
      activeTimeouts.forEach(timeoutId => {
        clearTimeout(timeoutId as any);
      });
      activeTimeouts.clear();
      global.setTimeout = originalSetTimeout;
    });

    it('getPoolIdentifiers and getPricesVolume SELL', async function () {
      const pools = await airswap.getPoolIdentifiers(
        forwarderTokens.signer,
        forwarderTokens.sender,
        SwapSide.SELL,
        blockNumber,
      );
      console.log(`Forwarder signer -> sender Pool Identifiers:`, pools);
      expect(pools.length).toBeGreaterThan(0);

      const poolPrices = await airswap.getPricesVolume(
        forwarderTokens.signer,
        forwarderTokens.sender,
        amountsForSell,
        SwapSide.SELL,
        blockNumber,
        pools,
      );
      console.log(`Forwarder signer -> sender Pool Prices:`, poolPrices);

      expect(poolPrices).not.toBeNull();
      checkPoolPrices(poolPrices!, amountsForSell, SwapSide.SELL, dexKey);
    });
  });

  describe('Forwarder Live RFQ', () => {
    const network = Network.SEPOLIA;
    const dexHelper = new DummyDexHelper(network);
    const config = AirSwapConfig.AirSwap[network];
    const logger = dexHelper.getLogger(dexKey);
    const forwarderClient = new ForwarderClient(dexHelper, logger, {
      forwarderUrl: config.forwarderUrl,
      forwarderHealthUrl: config.forwarderHealthUrl,
    });

    const signerToken = '0x20aaebad8c7c6ffb6fdaa5a622c399561562beea';
    const senderToken = '0xf450ef4f268eaf2d3d8f9ed0354852e255a5eaef';
    const amount = '1000000';
    const wallet = '0x1D693a4425bf7eD10FE7775E2b65b072019FFceb';

    const baseParams = {
      chainId: network.toString(),
      swapContract: config.swapERC20Address,
      signerToken,
      senderToken,
      senderWallet: wallet,
      minExpiry: MIN_EXPIRY.toString(),
      proxyingFor: wallet,
    };

    it('fetches signer-side order (SELL)', async () => {
      const { request } = dexHelper.httpRequest;
      const agent = new https.Agent({ keepAlive: false });
      const requestSpy = jest
        .spyOn(dexHelper.httpRequest, 'request')
        .mockImplementationOnce(async config => {
          try {
            return await request.call(dexHelper.httpRequest, {
              ...config,
              httpAgent: agent,
              httpsAgent: agent,
            });
          } finally {
            agent.destroy();
          }
        });

      const order = await forwarderClient.getSignerSideOrderERC20({
        ...baseParams,
        senderAmount: amount,
      });

      expect(order.signerToken.toLowerCase()).toBe(signerToken.toLowerCase());
      expect(order.senderToken.toLowerCase()).toBe(senderToken.toLowerCase());
      expect(order.senderAmount).toBe(amount);
      expect(BigInt(order.expiry)).toBeGreaterThan(
        BigInt(Math.floor(Date.now() / 1000)),
      );
      expect(order.r).toBeTruthy();
      expect(order.s).toBeTruthy();

      requestSpy.mockRestore();
    });

    it('fetches sender-side order (BUY)', async () => {
      const { request } = dexHelper.httpRequest;
      const agent = new https.Agent({ keepAlive: false });
      const requestSpy = jest
        .spyOn(dexHelper.httpRequest, 'request')
        .mockImplementationOnce(async config => {
          try {
            return await request.call(dexHelper.httpRequest, {
              ...config,
              httpAgent: agent,
              httpsAgent: agent,
            });
          } finally {
            agent.destroy();
          }
        });

      const order = await forwarderClient.getSenderSideOrderERC20({
        ...baseParams,
        signerAmount: amount,
      });

      expect(order.signerToken.toLowerCase()).toBe(signerToken.toLowerCase());
      expect(order.senderToken.toLowerCase()).toBe(senderToken.toLowerCase());
      expect(order.signerAmount).toBe(amount);
      expect(BigInt(order.expiry)).toBeGreaterThan(
        BigInt(Math.floor(Date.now() / 1000)),
      );
      expect(order.r).toBeTruthy();
      expect(order.s).toBeTruthy();

      requestSpy.mockRestore();
    });
  });
});
