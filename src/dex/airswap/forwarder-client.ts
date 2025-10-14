import { IDexHelper } from '../../dex-helper/idex-helper';
import { Logger } from '../../types';
import { v4 as uuid } from 'uuid';

export interface ForwarderClientConfig {
  forwarderUrl: string;
  forwarderHealthUrl: string;
}

export interface ForwarderHealth {
  version: string;
  status: string;
  registry: string;
  timestamp: number;
  uptime: number;
  chains: Array<{
    chainId: number;
    servers: {
      ws: string[];
      http: string[];
    };
    protocols: string[];
  }>;
  activeSockets: {
    clients: number;
    servers: number;
  };
}

export interface GetOrderParams {
  chainId: string;
  swapContract: string;
  signerToken: string;
  signerAmount?: string;
  senderToken: string;
  senderAmount?: string;
  senderWallet: string;
  minExpiry: string;
  proxyingFor: string;
}

export interface OrderResult {
  nonce: string;
  expiry: string;
  signerWallet: string;
  signerToken: string;
  signerAmount: string;
  senderToken: string;
  senderAmount: string;
  v: string;
  r: string;
  s: string;
}

/**
 * Client for interacting with the AirSwap Forwarder
 * https://forwarder.airswap.xyz
 */
export class ForwarderClient {
  private forwarderUrl: string;
  private forwarderHealthUrl: string;

  constructor(
    private dexHelper: IDexHelper,
    private logger: Logger,
    config: ForwarderClientConfig,
  ) {
    this.forwarderUrl = config.forwarderUrl;
    this.forwarderHealthUrl = config.forwarderHealthUrl;
  }

  /**
   * Check forwarder health status
   */
  async checkHealth(): Promise<ForwarderHealth | null> {
    try {
      const response = await this.dexHelper.httpRequest.request({
        url: this.forwarderHealthUrl,
        method: 'GET',
        timeout: 5000,
      });
      return response.data as ForwarderHealth;
    } catch (e) {
      this.logger.warn('Forwarder health check failed', e);
      return null;
    }
  }

  /**
   * Get all pricing from the forwarder
   * Equivalent to getAllPricingERC20 from individual servers
   */
  async getAllPricing() {
    try {
      const response = await this.dexHelper.httpRequest.request({
        url: this.forwarderUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        data: {
          jsonrpc: '2.0',
          id: uuid(),
          method: 'getAllPricingERC20',
          params: {},
        },
        timeout: 10000,
      });

      // Handle both direct result and nested result format
      if (response.data?.result) {
        return response.data.result;
      }
      return response.data;
    } catch (e) {
      this.logger.warn('Failed to fetch pricing from forwarder', e);
      return null;
    }
  }

  /**
   * Get a signed order from the forwarder (signer side)
   * The forwarder will aggregate quotes from multiple makers
   */
  async getSignerSideOrderERC20(params: GetOrderParams): Promise<OrderResult> {
    const response = await this.dexHelper.httpRequest.request({
      url: this.forwarderUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        jsonrpc: '2.0',
        id: uuid(),
        method: 'getSignerSideOrderERC20',
        params,
      },
      timeout: 30000, // RFQ might take longer
    });

    if (response.data?.error) {
      throw new Error(
        `Forwarder RFQ error: ${JSON.stringify(response.data.error)}`,
      );
    }

    if (!response.data?.result) {
      throw new Error('Forwarder returned no result');
    }

    return response.data.result as OrderResult;
  }

  /**
   * Get a signed order from the forwarder (sender side)
   */
  async getSenderSideOrderERC20(params: GetOrderParams): Promise<OrderResult> {
    const response = await this.dexHelper.httpRequest.request({
      url: this.forwarderUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        jsonrpc: '2.0',
        id: uuid(),
        method: 'getSenderSideOrderERC20',
        params,
      },
      timeout: 30000,
    });

    if (response.data?.error) {
      throw new Error(
        `Forwarder RFQ error: ${JSON.stringify(response.data.error)}`,
      );
    }

    if (!response.data?.result) {
      throw new Error('Forwarder returned no result');
    }

    return response.data.result as OrderResult;
  }
}
