import { Interface } from 'ethers/lib/utils';
import { assert } from 'ts-essentials';
import { OptimalSwapExchange } from '@paraswap/core';
import SwapERC20 from '@airswap/swap-erc20/build/contracts/SwapERC20.sol/SwapERC20.json';
import { getCostByPricing, Pricing } from '@airswap/utils';

import { Fetcher, SkippingRequest } from '../../lib/fetcher/fetcher';
import {
  Token,
  ExchangePrices,
  ExchangeTxInfo,
  PreprocessTransactionOptions,
  PoolLiquidity,
  SimpleExchangeParam,
  AdapterExchangeParam,
  Address,
  PoolPrices,
  Logger,
} from '../../types';

import { Network, SwapSide } from '../../constants';
import { SimpleExchange } from '../simple-exchange';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { IDex } from '../../dex/idex';
import { getDexKeysWithNetwork } from '../../utils';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';

import { AirSwapConfig } from './config';
import { AirSwapOrderResponse } from './types';
import { ForwarderClient } from './forwarder-client';

export const MIN_EXPIRY = 100000;
export const CACHE_TTL = 3000;
export const POLLING_INTERVAL = 3000;
export const GAS_COST = 100_000;

export class AirSwap
  extends SimpleExchange
  implements IDex<AirSwapOrderResponse>
{
  readonly isStatePollingDex = true;
  readonly hasConstantPriceLargeAmounts = false;
  readonly needWrapNative = true;
  readonly needsSequentialPreprocessing = true;
  readonly isFeeOnTransferSupported = false;

  protected swapInterface = new Interface(SwapERC20.abi);
  private swapERC20Address: string;
  private forwarderClient: ForwarderClient | null = null;
  private worker: Fetcher<Pricing[]> | null = null;
  private latestPricing: Pricing[] = [];

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(AirSwapConfig);
  logger: Logger;

  constructor(
    protected network: Network,
    public dexKey: string,
    readonly dexHelper: IDexHelper,
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
    const config = AirSwapConfig.AirSwap[network];
    assert(config, `${dexKey}: Network ${network} not supported`);
    this.swapERC20Address = config.swapERC20Address;
  }

  /**
   * @name initializePricing
   * @description Called by the engine at startup
   */
  async initializePricing(blockNumber: number): Promise<void> {
    const config = AirSwapConfig.AirSwap[this.network];

    this.logger.info(`Initializing with forwarder URL: ${config.forwarderUrl}`);

    // Initialize forwarder client
    this.forwarderClient = new ForwarderClient(this.dexHelper, this.logger, {
      forwarderUrl: config.forwarderUrl,
      forwarderHealthUrl: config.forwarderHealthUrl,
    });

    // Check health (optional)
    const health = await this.forwarderClient.checkHealth().catch(() => null);
    if (health) {
      this.logger.info(
        `Forwarder: ${health.status}, chains: ${health.chains.length}`,
      );
    }

    // Start polling
    if (!this.dexHelper.config.isSlave) {
      this.startWorker();
    }
  }

  /**
   * @name startWorker
   * @description Start polling forwarder for pricing (using old cleaner pattern)
   */
  startWorker(): void {
    this.worker?.stopPolling();

    assert(this.forwarderClient, 'ForwarderClient not initialized');

    const config = AirSwapConfig.AirSwap[this.network];

    // Poll forwarder for pricing using the old, cleaner pattern
    this.worker = new Fetcher<Pricing[]>(
      this.dexHelper.httpRequest,
      {
        info: {
          requestOptions: { url: config.forwarderUrl },
          requestFunc: async () => {
            const pricing = await this.forwarderClient!.getAllPricing();
            if (!Array.isArray(pricing)) {
              return new SkippingRequest('no pricing data');
            }
            return {
              data: pricing,
              status: 200,
              statusText: 'OK',
              headers: {},
            };
          },
          caster: (data: unknown): Pricing[] => {
            if (Array.isArray(data)) {
              return data as Pricing[];
            }
            return [];
          },
        },
        handler: async (pricing: Pricing[]) => {
          if (!pricing || !pricing.length) {
            this.logger.debug('Empty pricing from forwarder');
            return;
          }
          this.logger.debug(`Forwarder pricing: ${pricing.length} pairs`);
          this.latestPricing = pricing;
        },
      },
      POLLING_INTERVAL,
      this.logger,
    );
    this.worker.startPolling();
  }

  /**
   * @name releaseResources
   * @description Called by the engine at shutdown
   */
  releaseResources(): void {
    this.worker?.stopPolling();
  }

  /**
   * @name getPoolIdentifiers
   * @description Called by the engine to get pool identifiers for a token pair
   * @param srcToken the first token of the pair
   * @param destToken the second token of the pair
   * @param side either sell or buy
   * @param blockNumber not used
   */
  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    _: number,
  ): Promise<string[]> {
    const _srcToken = this.dexHelper.config.wrapETH(srcToken);
    const _destToken = this.dexHelper.config.wrapETH(destToken);

    if (_srcToken.address === _destToken.address) {
      return [];
    }

    // Forwarder is single aggregated pool
    return [
      `${this.dexKey}_${_srcToken.address}_${_destToken.address}_forwarder`.toLowerCase(),
    ];
  }

  /**
   * @name getPricesVolume
   * @description Called by the engine to get pricing for a token pair
   * @param srcToken the first token of the pair
   * @param destToken the second token of the pair
   * @param amounts the amounts to get prices for
   * @param side either sell or buy
   * @param blockNumber
   * @param limitPools a set of pool identifiers to use
   */
  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<AirSwapOrderResponse>> {
    try {
      const _srcToken = this.dexHelper.config.wrapETH(srcToken);
      const _destToken = this.dexHelper.config.wrapETH(destToken);

      if (_srcToken.address === _destToken.address) {
        return null;
      }

      const pricing =
        this.latestPricing.length > 0
          ? this.latestPricing
          : ((await this.forwarderClient?.getAllPricing()) as
              | Pricing[]
              | null) ?? [];

      if (!pricing.length) {
        this.logger.warn('No pricing available from forwarder');
        return null;
      }
      const prices: bigint[] = [];

      // Calculate prices for each amount
      for (const amount of amounts) {
        try {
          const isSell = side === SwapSide.SELL;
          const makerSide = isSell ? 'sell' : 'buy';
          const lookupBase = isSell ? _srcToken.address : _destToken.address;
          const lookupQuote = isSell ? _destToken.address : _srcToken.address;

          const price = getCostByPricing(
            makerSide,
            amount.toString(),
            lookupBase,
            lookupQuote,
            pricing,
          );
          prices.push(BigInt(price ?? 0));
        } catch (e) {
          prices.push(BigInt(0));
        }
      }

      const poolIdentifier = (
        await this.getPoolIdentifiers(srcToken, destToken, side, blockNumber)
      )[0];

      return [
        {
          gasCost: GAS_COST,
          exchange: this.dexKey,
          data: {},
          prices,
          unit: BigInt(1),
          poolIdentifier,
          poolAddresses: [this.swapERC20Address],
        } as PoolPrices<AirSwapOrderResponse>,
      ];
    } catch (e) {
      this.logger.error(`Error_getPricesVolume`, e);
      return null;
    }
  }

  /**
   * @name preProcessTransaction
   * @description Called by the engine to get a signed order
   * @param optimalSwapExchange order request params
   * @param srcToken the first token of the pair
   * @param destToken the second token of the pair
   * @param side either sell or buy
   * @param options transaction options
   */
  async preProcessTransaction(
    optimalSwapExchange: OptimalSwapExchange<AirSwapOrderResponse>,
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    options: PreprocessTransactionOptions,
  ): Promise<[OptimalSwapExchange<AirSwapOrderResponse>, ExchangeTxInfo]> {
    assert(
      this.forwarderClient,
      `${this.dexKey}-${this.network}: ForwarderClient not initialized`,
    );

    const _srcToken = this.dexHelper.config.wrapETH(srcToken);
    const _destToken = this.dexHelper.config.wrapETH(destToken);

    // Build order params
    const params: any = {
      chainId: this.network.toString(),
      swapContract: this.swapERC20Address,
      senderWallet: this.augustusAddress,
      minExpiry: MIN_EXPIRY.toString(),
      proxyingFor: options.txOrigin,
    };

    let order;

    if (side === SwapSide.SELL) {
      // SELL: provide srcAmount
      params.senderToken = _destToken.address;
      params.senderAmount = optimalSwapExchange.srcAmount;
      params.signerToken = _srcToken.address;
      order = await this.forwarderClient.getSignerSideOrderERC20(params);
    } else {
      // BUY: want destAmount
      params.signerToken = _destToken.address;
      params.signerAmount = optimalSwapExchange.destAmount;
      params.senderToken = _srcToken.address;
      order = await this.forwarderClient.getSenderSideOrderERC20(params);
    }

    return [
      {
        ...optimalSwapExchange,
        data: {
          order,
        },
      },
      { deadline: BigInt(order.expiry) },
    ];
  }

  /**
   * @name getSimpleParam
   * @description Build transaction calldata
   */
  async getSimpleParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AirSwapOrderResponse,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    const { order } = data;

    assert(
      order !== undefined,
      `${this.dexKey}-${this.network}: order undefined`,
    );

    const values = [
      order.nonce,
      order.expiry,
      order.signerWallet,
      order.signerToken,
      order.signerAmount,
      order.senderToken,
      order.senderAmount,
      order.v,
      order.r,
      order.s,
    ];

    const swapData = this.swapInterface.encodeFunctionData('swapLight', values);

    return this.buildSimpleParamWithoutWETHConversion(
      order.senderToken,
      order.senderAmount,
      order.signerToken,
      order.signerAmount,
      swapData,
      this.swapERC20Address,
    );
  }

  /**
   * @name getTopPoolsForToken
   * @description Called by the engine to get token pool sizes
   * @param tokenAddress the address of the token
   * @param limit max number of results
   */
  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    return [];
  }

  /**
   * @name getTokenFromAddress
   * @description Called by the engine to get token metadata
   * @param address the address of the token
   */
  getTokenFromAddress?(address: Address): Token {
    return { address, decimals: 0 };
  }

  async updatePoolState(): Promise<void> {
    // Pricing is updated on an interval by the fetcher.
    return Promise.resolve();
  }

  async isBlacklisted(userAddress?: string | undefined): Promise<boolean> {
    return Promise.resolve(false);
  }

  async setBlacklist(userAddress: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return null;
  }
  getCalldataGasCost(
    poolPrices: PoolPrices<AirSwapOrderResponse>,
  ): number | number[] {
    return CALLDATA_GAS_COST.DEX_NO_PAYLOAD;
  }
  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AirSwapOrderResponse,
    side: SwapSide,
  ): AdapterExchangeParam {
    const payload = '';
    return {
      targetExchange: this.swapERC20Address,
      payload,
      networkFee: '0',
    };
  }
}
