/**
 * Enrichment layer public API
 *
 * Re-exports all enrichment sources so callers import from one place.
 * To swap OTC Markets for a different provider, replace the implementation
 * in otcMarkets.ts — this barrel and all callers remain unchanged.
 */

export { fetchOtcShareStructure } from './otcMarkets';
