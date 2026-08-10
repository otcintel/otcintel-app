/**
 * Parser orchestrator
 *
 * Runs all parsers against a RawFiling and returns a ParsedFiling.
 * Each parser is run independently — errors in one do not block others.
 *
 * Form-type gating: not every parser runs on every form type.
 * - Financing parser: 8-K, 8-K/A, S-1, S-1/A
 * - Share structure parser: all forms with financial statements
 * - Dilution parser: all forms
 */

import type { RawFiling, ParsedFiling, EventType } from '../types';
import { FINANCING_FORM_TYPES, STRUCTURE_FORM_TYPES } from '../types';
import { parseFinancingTerms } from './financing';
import { parseShareStructure } from './shareStructure';
import { parseDilutionLanguage } from './dilution';
import { parseEventSummary } from './eventSummary';
import { parseEventType } from './eventType';
import { parseFinancingReport } from './financingReport';

/** Form types that receive the structured financing report */
const FINANCING_REPORT_FORM_TYPES = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A']);

/**
 * Run all applicable parsers on a RawFiling.
 * `filing.text` must be populated before calling this function.
 *
 * Returns a ParsedFiling with extractions and any non-fatal parse errors.
 */
export function parseRawFiling(filing: RawFiling): ParsedFiling {
  const parseErrors: string[] = [];
  const text = filing.text ?? '';

  if (!text) {
    parseErrors.push('No filing text available — text fetch may have failed or been skipped.');
    return {
      raw: filing,
      parsedAt: new Date().toISOString(),
      parseErrors,
    };
  }

  // ── Financing parser ──
  let financing = undefined;
  if (FINANCING_FORM_TYPES.includes(filing.formType)) {
    try {
      financing = parseFinancingTerms(text);
    } catch (err) {
      parseErrors.push(`Financing parser error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Share structure parser ──
  let shareStructure = undefined;
  if (STRUCTURE_FORM_TYPES.includes(filing.formType)) {
    try {
      shareStructure = parseShareStructure(text);
    } catch (err) {
      parseErrors.push(`Share structure parser error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Dilution parser ── (runs on all form types)
  let dilution = undefined;
  try {
    dilution = parseDilutionLanguage(text);
  } catch (err) {
    parseErrors.push(`Dilution parser error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Event summary + event type parsers ── (8-K and 8-K/A only)
  let eventSummary: string | undefined;
  let eventType: EventType | undefined;
  if (filing.formType === '8-K' || filing.formType === '8-K/A') {
    try {
      eventSummary = parseEventSummary(text, filing.items);
    } catch (err) {
      parseErrors.push(`Event summary parser error: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      eventType = parseEventType(text, filing.items);
    } catch (err) {
      parseErrors.push(`Event type parser error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Financing report ── (10-K, 10-K/A, 10-Q, 10-Q/A only)
  let financingReport = undefined;
  if (FINANCING_REPORT_FORM_TYPES.has(filing.formType)) {
    try {
      financingReport = parseFinancingReport(text);
    } catch (err) {
      parseErrors.push(`Financing report parser error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    raw: filing,
    financing,
    shareStructure,
    dilution,
    eventSummary,
    eventType,
    financingReport,
    parsedAt: new Date().toISOString(),
    parseErrors,
  };
}
