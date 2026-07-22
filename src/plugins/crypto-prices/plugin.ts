/**
 * The Crypto Prices plugin definition (CCB-S3-004 §0).
 *
 * This is the whole surface a plugin has to declare: who it is, whether it is on
 * by default, which intents it contributes, and where its settings live. Adding a
 * second plugin is another file exactly like this one — no change to the sidebar,
 * the resolver, or the settings framework.
 */

import { definePlugin } from '../registry.js';

export const CRYPTO_PRICES_ID = 'crypto-prices';

export const cryptoPricesPlugin = definePlugin({
  id: CRYPTO_PRICES_ID,
  name: 'Crypto Prices',
  description:
    'Answers price and conversion questions from a chain of market-data providers, with every symbol pinned to a canonical asset.',
  version: '1.0.0',
  defaultEnabled: true,
  // While the plugin is off, PRICE is absent from the active catalog entirely:
  // the rule engine skips its patterns and the resolver seam rejects it.
  intents: ['PRICE'],
  adminPath: '/plugins/crypto-prices',
});
