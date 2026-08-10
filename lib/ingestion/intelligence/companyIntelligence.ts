/**
 * Company Intelligence Generator
 *
 * Analyses all normalized filings for a ticker and produces a structured
 * CompanyIntelligence object containing share structure trends, aggregated
 * financing data, ranked risk factors, positive signals, and an analyst-style
 * executive summary.
 *
 * This runs in O(n) over the filing list — no external calls, pure computation.
 */

import type {
  NormalizedFiling,
  CompanyIntelligence,
  DilutionRiskLevel,
  RiskSeverity,
  CompanyRiskFactor,
  CompanyPositiveSignal,
  ShareTrendPeriod,
  ShareStructureTrend,
  AggregatedFinancingProfile,
  RelatedPartyTransaction,
} from '../types';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt$(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000)         return `$${Math.round(n / 1_000)}K`;
  return `$${n.toLocaleString()}`;
}

function fmtShares(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000)         return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString();
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`;
}

// ─── Share structure trend ────────────────────────────────────────────────────

function buildShareStructureTrend(filings: NormalizedFiling[]): ShareStructureTrend {
  // Collect data points from annual/quarterly SEC filings first, then OTC fallback
  const dataPoints: ShareTrendPeriod[] = [];

  // Priority: 10-K/10-Q with SEC shareStructure
  const annualQuarterly = [...filings]
    .filter(f => ['10-K','10-K/A','10-Q','10-Q/A'].includes(f.formType) && f.shareStructure?.sharesOutstanding)
    .sort((a, b) => a.filedAt.localeCompare(b.filedAt)); // oldest first

  for (const f of annualQuarterly) {
    dataPoints.push({
      filedAt:           f.filedAt,
      formType:          f.formType,
      sharesOutstanding: f.shareStructure!.sharesOutstanding!,
      sharesAuthorized:  f.shareStructure!.sharesAuthorized,
      source:            'sec',
    });
  }

  // If no SEC data, fall back to OTC
  if (dataPoints.length === 0) {
    const otc = [...filings]
      .filter(f => f.otcShareStructure?.sharesOutstanding)
      .sort((a, b) => a.filedAt.localeCompare(b.filedAt));
    for (const f of otc) {
      dataPoints.push({
        filedAt:           f.filedAt,
        formType:          f.formType,
        sharesOutstanding: f.otcShareStructure!.sharesOutstanding!,
        sharesAuthorized:  f.otcShareStructure!.authorizedShares,
        source:            'otc',
      });
    }
  }

  // Keep most recent 6 periods max
  const periods = dataPoints.slice(-6);

  // Compute growth rates
  const periodicGrowthRates: number[] = [];
  for (let i = 1; i < periods.length; i++) {
    const prev = periods[i - 1].sharesOutstanding;
    const curr = periods[i].sharesOutstanding;
    periodicGrowthRates.push(prev > 0 ? ((curr - prev) / prev) * 100 : 0);
  }

  const totalGrowthPct = periods.length >= 2
    ? ((periods[periods.length - 1].sharesOutstanding - periods[0].sharesOutstanding) / periods[0].sharesOutstanding) * 100
    : undefined;

  // Acceleration: most recent growth rate > average of prior rates
  const isAccelerating = periodicGrowthRates.length >= 2
    ? periodicGrowthRates[periodicGrowthRates.length - 1] >
      periodicGrowthRates.slice(0, -1).reduce((s, r) => s + r, 0) / (periodicGrowthRates.length - 1)
    : false;

  // Narrative
  let narrative: string;
  if (periods.length === 0) {
    narrative = 'No share count data found across retrieved filings.';
  } else if (periods.length === 1) {
    const p = periods[0];
    narrative = `Shares outstanding stand at ${fmtShares(p.sharesOutstanding)} as of the most recent filing (${p.formType} · ${p.filedAt}). Insufficient data to establish a trend.`;
  } else {
    const first = periods[0];
    const last  = periods[periods.length - 1];
    const growthStr = totalGrowthPct !== undefined ? ` (${pct(totalGrowthPct)})` : '';
    const dirWord = (totalGrowthPct ?? 0) > 5 ? 'increased' : (totalGrowthPct ?? 0) < -5 ? 'decreased' : 'remained relatively stable';
    const accelStr = isAccelerating && (totalGrowthPct ?? 0) > 10
      ? ' The pace of dilution appears to be accelerating.'
      : !isAccelerating && (totalGrowthPct ?? 0) > 10
      ? ' The pace of dilution appears to be decelerating or holding steady.'
      : '';
    narrative = `Shares outstanding ${dirWord} from ${fmtShares(first.sharesOutstanding)} to ${fmtShares(last.sharesOutstanding)} across ${periods.length} reporting periods${growthStr}.${accelStr}`;
  }

  return { periods, totalGrowthPct, periodicGrowthRates, isAccelerating, narrative };
}

// ─── Financing profile aggregation ───────────────────────────────────────────

/**
 * Produce a reliable related-party loan total from a single filing.
 *
 * STRICT RULES — designed to prevent the $162M / $37M aggregation artefacts:
 *
 * 1. Only `ending_balance` basis records contribute to the total.
 *    `unknown` basis = confidence insufficient → excluded from total.
 *    Activity flows (advance, repayment, period_activity, compensation_expense,
 *    beginning_balance) are always excluded.
 *
 * 2. Only loan-type records are counted.  Compensation, lease, and service
 *    transactions are completely separate and never added to the loan total.
 *
 * 3. Deduplicate by party key: keep the highest-amount ending_balance per party.
 *    This absorbs sentence-layer + table-layer double-extraction of the same balance.
 *
 * 4. Single-record plausibility cap: exclude records > $30M (multiplier errors, etc.)
 *
 * Returns undefined when no `ending_balance` records survived all filters —
 * caller MUST publish `undefined` / "could not be determined" rather than zero.
 */
function buildRelatedPartyTotal(
  records:     RelatedPartyTransaction[],
  warnings:    string[],
  filingLabel: string,
  totalLiabilities?: number,
): number | undefined {
  const SINGLE_RECORD_CAP = 30_000_000;

  const CONFIDENCE_GATE = 0.85;

  // Step 1: keep only ending_balance, loan-type records with positive amounts and sufficient confidence
  const balanceRecords: RelatedPartyTransaction[] = [];
  for (const t of records) {
    if (t.transactionType && t.transactionType !== 'loan') continue;
    if (t.basis !== 'ending_balance') continue;                    // only confirmed balances
    if ((t.confidence ?? 0) < CONFIDENCE_GATE) continue;          // requires explicit loan-balance phrase
    const amt = t.amount ?? 0;
    if (amt <= 0) continue;
    if (amt > SINGLE_RECORD_CAP) {
      warnings.push(
        `VALIDATION: Related-party record excluded — $${(amt / 1e6).toFixed(2)}M ` +
        `from "${t.partyDescription ?? 'unknown party'}" in ${filingLabel} ` +
        `exceeds single-record plausibility cap ($${(SINGLE_RECORD_CAP / 1e6).toFixed(0)}M).`,
      );
      continue;
    }
    balanceRecords.push(t);
  }

  // Step 2: if no records survived all filters, report why and return undefined
  if (balanceRecords.length === 0) {
    // Count records that have ending_balance basis but failed the confidence gate
    const lowConfidenceCount = records.filter(
      t => (!t.transactionType || t.transactionType === 'loan') &&
           t.basis === 'ending_balance' && (t.confidence ?? 0) < CONFIDENCE_GATE && (t.amount ?? 0) > 0,
    ).length;
    const unknownCount = records.filter(
      t => (!t.transactionType || t.transactionType === 'loan') &&
           (!t.basis || t.basis === 'unknown') && (t.amount ?? 0) > 0,
    ).length;
    if (lowConfidenceCount > 0) {
      warnings.push(
        `VALIDATION: ${lowConfidenceCount} related-party record(s) in ${filingLabel} have ` +
        `basis=ending_balance but confidence < ${CONFIDENCE_GATE}. ` +
        `Either no explicit loan-balance phrase was found in source text, or the reported ` +
        `amount could not be confirmed near the loan-balance phrase (amount may come from ` +
        `an unrelated part of the same section — e.g., a facility size, compensation total, ` +
        `or prior-period balance). Related-party loan total will not be published.`,
      );
    } else if (unknownCount > 0) {
      warnings.push(
        `VALIDATION: ${unknownCount} related-party loan record${unknownCount > 1 ? 's' : ''} found ` +
        `in ${filingLabel} but none have confirmed basis (ending_balance). ` +
        `Cannot reliably distinguish balance-sheet snapshots from activity flows. ` +
        `Related-party balance will not be published.`,
      );
    }
    return undefined;
  }

  // Step 3: deduplicate by party — keep highest amount per party
  const byParty = new Map<string, RelatedPartyTransaction>();
  for (const t of balanceRecords) {
    const key = t.partyDescription?.trim().toLowerCase() ?? 'unknown';
    const existing = byParty.get(key);
    if (!existing || (t.amount ?? 0) > (existing.amount ?? 0)) {
      byParty.set(key, t);
    }
  }

  // Step 3b: deduplicate by amount — when two instruments both extract from the same
  // phrase sentence they yield identical amounts; prevent double-counting.
  const seenAmounts = new Set<number>();
  const dedupedRecords: RelatedPartyTransaction[] = [];
  for (const t of byParty.values()) {
    const centAmt = Math.round((t.amount ?? 0) * 100);
    if (!seenAmounts.has(centAmt)) {
      seenAmounts.add(centAmt);
      dedupedRecords.push(t);
    }
  }

  const total = dedupedRecords.reduce((s, t) => s + (t.amount ?? 0), 0);

  // Step 4: cross-check against total liabilities
  if (totalLiabilities && totalLiabilities > 0 && total > totalLiabilities * 0.9) {
    warnings.push(
      `VALIDATION: Related-party loan total ${fmt$(total)} from ${filingLabel} exceeds ` +
      `90% of reported total liabilities (${fmt$(totalLiabilities)}). ` +
      `This is implausible — figure excluded. Verify directly against the filing.`,
    );
    return undefined;
  }

  return total;
}

function buildFinancingProfile(ticker: string, filings: NormalizedFiling[]): AggregatedFinancingProfile {
  const reportsNewestFirst = [...filings]
    .filter(f => f.financingReport && ['10-K','10-K/A','10-Q','10-Q/A'].includes(f.formType))
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt));

  // ── Notes, facilities, warrants — aggregate across filings (instruments persist)
  const allNotes = reportsNewestFirst.flatMap(f => f.financingReport!.convertibleDebt);

  // Collect facilities with source-filing provenance (newest first preserves recency)
  const allFacilitiesWithSource = reportsNewestFirst.flatMap(f =>
    (f.financingReport!.equityFacilities ?? []).map(fac => ({
      ...fac,
      _sourceFiling: `${f.formType} · ${f.filedAt}`,
    })),
  );

  const allWarrants = reportsNewestFirst.flatMap(f => f.financingReport!.warrants);

  // Deduplicate notes by principal (same instrument across quarters)
  const seenPrincipal = new Set<number>();
  const uniqueNotes   = allNotes.filter(n => {
    const key = n.principalAmount ?? n.outstandingBalance ?? -1;
    if (key < 0 || seenPrincipal.has(key)) return false;
    seenPrincipal.add(key);
    return true;
  });

  // Deduplicate facilities by facility type, newest-filing-wins.
  //
  // IDENTITY RULES:
  // 1. The newest filing controls current active status for each facility type.
  // 2. Multiple appearances of the same type in different filings = same facility in
  //    different reporting periods (not additional facilities).
  // 3. Within a single filing, different-sized facilities of the same type may be
  //    genuinely separate agreements and are both kept.
  // 4. A size change across filings is a probable amendment — emit an ambiguity warning
  //    but use the most-recent committed amount (do not sum old + new amounts).
  // 5. Counterparty names are not used for identity because extraction is unreliable:
  //    section headers can be mis-identified as counterparty names.
  //
  // This prevents $30M (Q2) + $10M (Q3) = $40M when both describe the same EFA.
  const facilityAmbiguityWarnings: string[] = [];

  // Group by facilityType, tracking which filing each group came from
  type FacWithSource = (typeof allFacilitiesWithSource)[0];
  const facilityByType = new Map<string, { facilities: FacWithSource[]; sourceFiling: string }>();
  const warnedFacilityTransitions = new Set<string>();  // avoid duplicate size-change warnings

  for (const fac of allFacilitiesWithSource) {
    const typeKey = fac.facilityType ?? 'unknown';
    const existing = facilityByType.get(typeKey);

    if (!existing) {
      // First (newest) filing for this type — record it
      facilityByType.set(typeKey, { facilities: [fac], sourceFiling: fac._sourceFiling ?? '' });
    } else if (fac._sourceFiling === existing.sourceFiling) {
      // Same filing, same type — these could be genuinely separate agreements
      // (e.g., two separate EFAs entered in the same quarter). Keep both.
      existing.facilities.push(fac);
    } else {
      // Older filing, same type → same facility at an earlier point.
      // Check if the size changed — that signals an amendment or replacement.
      const newestSize = existing.facilities[0].facilitySize ?? 0;
      const olderSize  = fac.facilitySize ?? 0;
      if (olderSize > 0 && newestSize > 0 && newestSize !== olderSize) {
        const transitionKey = `${typeKey}:${olderSize}→${newestSize}`;
        if (!warnedFacilityTransitions.has(transitionKey)) {
          warnedFacilityTransitions.add(transitionKey);
          facilityAmbiguityWarnings.push(
            `FACILITY: ${typeKey} commitment changed from ${fmt$(olderSize)} (${fac._sourceFiling}) ` +
            `to ${fmt$(newestSize)} (${existing.sourceFiling}). ` +
            `Using most-recent amount (${fmt$(newestSize)}). ` +
            `Verify whether this is an amendment, partial draw, or replacement agreement.`,
          );
        }
      }
      // Skip the older filing's facility — do not add it to the total
    }
  }

  const uniqueFacilities = [...facilityByType.values()].flatMap(g => g.facilities);

  // Deduplicate warrants by share count + exercise price
  const seenWarrant = new Set<string>();
  const uniqueWarrants = allWarrants.filter(w => {
    const key = `${w.warrantShares ?? '?'}:${w.exercisePrice ?? '?'}`;
    if (seenWarrant.has(key)) return false;
    seenWarrant.add(key);
    return true;
  });

  // ── Related-party loans ──────────────────────────────────────────────────────
  //
  // Strategy: scan most-recent-first until we get a confident total.
  // A loan balance is a balance-sheet snapshot — the same balance in Q1, Q2, Q3 is
  // THE SAME LOAN, not three loans.  We only publish a total when at least one record
  // has basis = 'ending_balance' (confirmed balance-sheet snapshot).
  const relatedPartyDataWarnings: string[] = [];
  let totalRelatedPartyLoans: number | undefined;
  let relatedPartyFilingSource: string | undefined;

  for (const f of reportsNewestFirst) {
    const rp = f.financingReport!.relatedPartyTransactions;
    if (rp.length === 0) continue;

    // Get total liabilities from financial statements for plausibility check
    const liabilities = f.financingReport!.financialStatements?.totalLiabilities;
    const label       = `${f.formType} · ${f.filedAt}`;
    const candidate   = buildRelatedPartyTotal(rp, relatedPartyDataWarnings, label, liabilities);

    if (candidate !== undefined) {
      totalRelatedPartyLoans   = candidate;
      relatedPartyFilingSource = label;
      break;   // found a reliable total — stop scanning older filings
    }
    // No ending_balance records in this filing — try the next most recent one
  }

  // ── Consolidate per-filing low-confidence RP warnings into one company-level warning ──
  const LOW_CONF_SNIPPET   = 'basis=ending_balance but confidence <';
  const UNKNOWN_BASIS_SNIPPET = 'but none have confirmed basis';
  const lowConfWarns    = relatedPartyDataWarnings.filter(w => w.includes(LOW_CONF_SNIPPET));
  const unknownBasisWarns = relatedPartyDataWarnings.filter(w => w.includes(UNKNOWN_BASIS_SNIPPET));
  const otherWarns      = relatedPartyDataWarnings.filter(
    w => !w.includes(LOW_CONF_SNIPPET) && !w.includes(UNKNOWN_BASIS_SNIPPET),
  );
  if (lowConfWarns.length > 1) {
    relatedPartyDataWarnings.length = 0;
    relatedPartyDataWarnings.push(...otherWarns, ...unknownBasisWarns);
    relatedPartyDataWarnings.push(
      `VALIDATION: Related-party loan balance could not be reliably extracted from ` +
      `${lowConfWarns.length} analyzed filings. The detected amounts were not confirmed ` +
      `near explicit loan-balance language (they may reflect unrelated section totals such as ` +
      `compensation or facility sizes). No related-party loan total has been published.`,
    );
  }

  // ── Computed totals ──────────────────────────────────────────────────────────
  const totalConvertiblePrincipal     = uniqueNotes.reduce((s, n) => s + (n.principalAmount ?? 0), 0);
  const totalConvertibleOutstanding   = uniqueNotes.reduce((s, n) => s + (n.outstandingBalance ?? n.principalAmount ?? 0), 0);
  const totalEquityFacilityCommitment = uniqueFacilities.reduce((s, f) => s + (f.facilitySize ?? 0), 0);
  const totalEquityFacilityDrawn      = uniqueFacilities.reduce((s, f) => s + (f.drawnAmount ?? 0), 0);
  const totalWarrantShares            = uniqueWarrants.reduce((s, w) => s + (w.warrantShares ?? 0), 0);
  // totalRelatedPartyLoans is already set above (undefined when confidence insufficient)

  const toxicNoteCount   = uniqueNotes.filter(n => n.discountRate && !n.hasFloorPrice && n.hasResetProvisions).length;
  const noFloorNoteCount = uniqueNotes.filter(n => n.discountRate && !n.hasFloorPrice).length;
  const resetNoteCount   = uniqueNotes.filter(n => n.hasResetProvisions).length;
  const hasActiveEloc    = uniqueFacilities.some(f => f.drawnAmount && f.drawnAmount > 0);

  // Plausibility cross-check: warn if RP total seems implausible vs context
  if (totalRelatedPartyLoans !== undefined &&
      totalRelatedPartyLoans > 10_000_000 &&
      uniqueNotes.length === 0 && !hasActiveEloc) {
    relatedPartyDataWarnings.push(
      `VALIDATION: Related-party loan total of ${fmt$(totalRelatedPartyLoans)} from ` +
      `${relatedPartyFilingSource ?? 'latest filing'} is being used as the primary financing figure ` +
      `(no convertible notes or equity facilities were detected). Verify against the filing directly.`,
    );
  }

  // Count 8-K financing events in the last 12 months
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const recentFinancingEvents = filings.filter(f =>
    f.formType === '8-K' && f.eventType === 'financing' && f.filedAt >= cutoffStr,
  ).length;

  // Total extraction warnings across all analyzed quarterly/annual filings
  const extractionWarningCount = reportsNewestFirst.reduce(
    (s, f) => s + (f.financingReport!.warnings?.length ?? 0), 0,
  );

  // ── Debug output for AITX (server console) ──────────────────────────────────
  if (ticker === 'AITX') {
    const CONF_GATE = 0.85;
    console.log('\n=== AITX Related-Party Debug ===');
    for (const f of reportsNewestFirst) {
      const rp = f.financingReport!.relatedPartyTransactions;
      if (rp.length === 0) continue;
      const isSourceFiling = relatedPartyFilingSource === `${f.formType} · ${f.filedAt}`;
      console.log(`\n[${f.formType} · ${f.filedAt}] (${rp.length} records) — ${isSourceFiling ? 'SOURCE' : 'older, skipped'}:`);
      for (const t of rp) {
        const basis = t.basis ?? 'unknown';
        const conf  = t.confidence ?? 0;
        const amt   = t.amount ?? 0;
        let exclusion = '';
        if (!isSourceFiling)                                            exclusion = 'older filing — not used';
        else if (t.transactionType && t.transactionType !== 'loan')    exclusion = `non-loan type: ${t.transactionType}`;
        else if (basis !== 'ending_balance')                           exclusion = `basis is "${basis}" — only ending_balance counted`;
        else if (conf < CONF_GATE)                                     exclusion = `confidence ${conf.toFixed(2)} < ${CONF_GATE} gate — phrase matched but amount not near phrase (or no explicit phrase)`;
        else if (amt > 30_000_000)                                     exclusion = 'exceeds $30M cap';
        else if (amt <= 0)                                             exclusion = 'zero or negative amount';
        const included = isSourceFiling && !exclusion;
        const phrase   = t.matchedPhrase ? ` phrase="${t.matchedPhrase}"` : '';
        console.log(
          `  party=${t.partyDescription ?? '?'} amount=$${(amt/1e6).toFixed(3)}M ` +
          `basis=${basis} conf=${conf.toFixed(2)}${phrase} type=${t.transactionType ?? '?'} ` +
          `included=${included}${exclusion ? ` [EXCLUDED: ${exclusion}]` : ''}`,
        );
      }
    }
    if (totalRelatedPartyLoans !== undefined) {
      console.log(`\nFinal totalRelatedPartyLoans: $${(totalRelatedPartyLoans/1e6).toFixed(3)}M from ${relatedPartyFilingSource}`);
    } else {
      console.log('\nFinal totalRelatedPartyLoans: UNDEFINED — no records passed all filters');
      if (relatedPartyDataWarnings.length > 0) {
        for (const w of relatedPartyDataWarnings) console.log(`  WARN: ${w}`);
      }
    }

    console.log('\n=== AITX Equity Facility Debug ===');
    console.log(`All facilities across filings (${allFacilitiesWithSource.length} total):`);
    for (const fac of allFacilitiesWithSource) {
      console.log(
        `  size=${fac.facilitySize ? fmt$(fac.facilitySize) : '?'} ` +
        `type=${fac.facilityType ?? '?'} cp="${fac.counterpartyName ?? '(none)'}" ` +
        `drawn=${fac.drawnAmount ? fmt$(fac.drawnAmount) : '0'} ` +
        `source=${fac._sourceFiling}`,
      );
    }
    console.log(`\nUnique facilities after identity dedup (${uniqueFacilities.length}):`);
    for (const fac of uniqueFacilities) {
      console.log(
        `  size=${fac.facilitySize ? fmt$(fac.facilitySize) : '?'} ` +
        `type=${fac.facilityType ?? '?'} cp="${fac.counterpartyName ?? '(none)'}" ` +
        `source=${fac._sourceFiling}`,
      );
    }
    console.log(`Total equity facility commitment: ${fmt$(totalEquityFacilityCommitment)}`);
    if (facilityAmbiguityWarnings.length > 0) {
      for (const w of facilityAmbiguityWarnings) console.log(`  AMBIGUITY: ${w}`);
    }
    console.log('================================\n');
  }

  // ── Narrative ────────────────────────────────────────────────────────────────
  const narrativeParts: string[] = [];
  if (totalConvertiblePrincipal > 0) {
    const noteDesc = uniqueNotes.length === 1 ? 'one convertible note' : `${uniqueNotes.length} convertible notes`;
    narrativeParts.push(`${noteDesc} totaling ${fmt$(totalConvertiblePrincipal)} in principal (${fmt$(totalConvertibleOutstanding)} outstanding)`);
  }
  if (totalEquityFacilityCommitment > 0) {
    const drawn = totalEquityFacilityDrawn > 0 ? `, ${fmt$(totalEquityFacilityDrawn)} drawn` : '';
    narrativeParts.push(`equity facilit${uniqueFacilities.length === 1 ? 'y' : 'ies'} totaling ${fmt$(totalEquityFacilityCommitment)} commitment${drawn}`);
  }
  if (totalRelatedPartyLoans !== undefined && totalRelatedPartyLoans > 0) {
    const sourceNote = relatedPartyFilingSource ? ` (as of ${relatedPartyFilingSource})` : '';
    narrativeParts.push(`${fmt$(totalRelatedPartyLoans)} in related-party loans${sourceNote}`);
  } else if (totalRelatedPartyLoans === undefined && relatedPartyDataWarnings.length > 0) {
    narrativeParts.push('related-party balance could not be reliably determined (see warnings)');
  }
  if (totalWarrantShares > 0) {
    narrativeParts.push(`${fmtShares(totalWarrantShares)} warrant shares outstanding`);
  }

  let narrative: string;
  if (narrativeParts.length === 0) {
    narrative = recentFinancingEvents > 0
      ? `${recentFinancingEvents} financing-related 8-K filings detected in the past 12 months, but no structured terms were extracted from quarterly or annual reports.`
      : 'No structured financing data identified across annual and quarterly reports.';
  } else {
    narrative = `The company carries ${narrativeParts.join(', ')}.`;
    if (recentFinancingEvents > 0) {
      narrative += ` Additionally, ${recentFinancingEvents} new financing event${recentFinancingEvents > 1 ? 's were' : ' was'} disclosed via 8-K in the past 12 months, indicating active debt issuance.`;
    }
  }

  return {
    totalConvertiblePrincipal,
    totalConvertibleOutstanding,
    totalEquityFacilityCommitment,
    totalEquityFacilityDrawn,
    totalWarrantShares,
    totalRelatedPartyLoans,
    toxicNoteCount,
    noFloorNoteCount,
    resetNoteCount,
    hasActiveEloc,
    recentFinancingEvents,
    narrative,
    relatedPartyFilingSource,
    relatedPartyDataWarnings,
    facilityAmbiguityWarnings,
    extractionWarningCount,
  };
}

// ─── Risk factor derivation ───────────────────────────────────────────────────

const SEVERITY_ORDER: Record<RiskSeverity, number> = { critical: 0, high: 1, moderate: 2, low: 3 };

function buildKeyRisks(
  profile:  AggregatedFinancingProfile,
  trend:    ShareStructureTrend,
  filings:  NormalizedFiling[],
): CompanyRiskFactor[] {
  // filings parameter reserved for future rule extensions
  void filings;

  const risks: CompanyRiskFactor[] = [];

  // Toxic notes (most dangerous structure)
  if (profile.toxicNoteCount > 0) {
    const count = profile.toxicNoteCount === 1 ? 'One convertible note' : `${profile.toxicNoteCount} convertible notes`;
    risks.push({
      severity: 'critical',
      label:    'Toxic Financing Structure',
      detail:   `${count} structured with variable conversion discount, no floor price, and anti-dilution reset provisions — a combination that enables unlimited share issuance at declining prices.`,
    });
  }

  // No-floor notes (without resets — still dangerous)
  const noFloorNoReset = profile.noFloorNoteCount - profile.toxicNoteCount;
  if (noFloorNoReset > 0) {
    risks.push({
      severity: 'high',
      label:    'No-Floor Convertibles',
      detail:   `${noFloorNoReset} convertible note${noFloorNoReset > 1 ? 's' : ''} with no floor price on conversion. Conversion price can fall arbitrarily as the stock price declines.`,
    });
  }

  // Reset provisions (even when floor present)
  if (profile.resetNoteCount > profile.toxicNoteCount) {
    const n = profile.resetNoteCount - profile.toxicNoteCount;
    risks.push({
      severity: 'high',
      label:    'Anti-Dilution Reset Provisions',
      detail:   `${n} note${n > 1 ? 's' : ''} contain reset or anti-dilution ratchet provisions not already flagged as toxic, which can reduce conversion prices in a downtrending market.`,
    });
  }

  // Share count > 10B
  const latestShares = trend.periods.length > 0
    ? trend.periods[trend.periods.length - 1].sharesOutstanding
    : 0;
  if (latestShares >= 10_000_000_000) {
    risks.push({
      severity: 'critical',
      label:    'Extreme Share Count',
      detail:   `Shares outstanding exceed 10 billion (${fmtShares(latestShares)}), placing this company among the most severely diluted OTC issuers. Even small conversion events produce enormous share counts.`,
    });
  } else if (latestShares >= 1_000_000_000) {
    risks.push({
      severity: 'high',
      label:    'High Share Count',
      detail:   `Shares outstanding exceed 1 billion (${fmtShares(latestShares)}), indicating significant prior dilution. A large float makes price appreciation structurally difficult.`,
    });
  }

  // Accelerating dilution
  if (trend.isAccelerating && (trend.totalGrowthPct ?? 0) > 15) {
    risks.push({
      severity: 'high',
      label:    'Accelerating Dilution',
      detail:   `Share count is growing at an increasing rate across reporting periods. The pace of dilution has not stabilized, suggesting ongoing or intensifying conversion activity.`,
    });
  } else if ((trend.totalGrowthPct ?? 0) > 50) {
    risks.push({
      severity: 'high',
      label:    'Rapid Share Count Growth',
      detail:   `Shares outstanding grew by approximately ${pct(trend.totalGrowthPct!)} across the observed periods, indicating substantial dilution over the measurement window.`,
    });
  } else if ((trend.totalGrowthPct ?? 0) > 15) {
    risks.push({
      severity: 'moderate',
      label:    'Meaningful Share Count Growth',
      detail:   `Shares outstanding grew by approximately ${pct(trend.totalGrowthPct!)} across the observed periods.`,
    });
  }

  // Active ELOC being drawn
  if (profile.hasActiveEloc) {
    risks.push({
      severity: 'high',
      label:    'Active Equity Line Being Drawn',
      detail:   `An equity facility is actively being utilized (${fmt$(profile.totalEquityFacilityDrawn)} drawn of ${fmt$(profile.totalEquityFacilityCommitment)} committed), providing an ongoing channel for share issuance independent of the note stack.`,
    });
  } else if (profile.totalEquityFacilityCommitment > 0) {
    risks.push({
      severity: 'moderate',
      label:    'Equity Facility in Place',
      detail:   `An equity line of credit totaling ${fmt$(profile.totalEquityFacilityCommitment)} is committed and available for draw. This represents latent dilution capacity that may be activated at any time.`,
    });
  }

  // Related-party dependence
  const rpLoans = profile.totalRelatedPartyLoans ?? 0;
  if (rpLoans > 0 && profile.totalConvertiblePrincipal === 0 && !profile.hasActiveEloc) {
    risks.push({
      severity: 'high',
      label:    'Related-Party Loan Dependence',
      detail:   `Related-party loans appear to be the primary funding source (${fmt$(rpLoans)} identified), suggesting limited access to institutional or third-party capital markets.`,
    });
  } else if (rpLoans > 0 && profile.totalConvertiblePrincipal > 0
    && rpLoans / profile.totalConvertiblePrincipal > 0.4) {
    risks.push({
      severity: 'moderate',
      label:    'Significant Related-Party Exposure',
      detail:   `Related-party loans represent a meaningful portion of the financing stack (${fmt$(rpLoans)}), which may indicate constrained access to independent capital.`,
    });
  }

  // Large authorized share count relative to outstanding
  const latestAuthorized = trend.periods.find(p => p.sharesAuthorized)?.sharesAuthorized;
  if (latestAuthorized && latestShares > 0) {
    const utilizationPct = (latestShares / latestAuthorized) * 100;
    if (latestAuthorized >= 10_000_000_000 && utilizationPct < 80) {
      risks.push({
        severity: 'moderate',
        label:    'Large Authorized Share Headroom',
        detail:   `${fmtShares(latestAuthorized)} shares are authorized with only ${utilizationPct.toFixed(0)}% currently issued, leaving substantial capacity for new share issuances without a shareholder vote.`,
      });
    }
  }

  // Heavy recent 8-K financing activity
  if (profile.recentFinancingEvents >= 4) {
    risks.push({
      severity: 'moderate',
      label:    'Frequent Financing Events',
      detail:   `${profile.recentFinancingEvents} financing-related 8-K filings in the past 12 months indicates the company is regularly issuing new debt instruments, suggesting chronic funding shortfalls.`,
    });
  }

  return risks.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// ─── Positive signal detection ────────────────────────────────────────────────

function buildPositiveSignals(
  filings:  NormalizedFiling[],
  trend:    ShareStructureTrend,
  profile:  AggregatedFinancingProfile,
): CompanyPositiveSignal[] {
  const signals: CompanyPositiveSignal[] = [];

  // Revenue / operational 8-Ks in last 12 months
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const operationalUpdates = filings.filter(
    f => f.eventType === 'operational_update' && f.filedAt >= cutoffStr,
  );
  const revenueUpdates = operationalUpdates.filter(f =>
    /revenue|recurring|arr|mrr|sales|milestone|record/i.test(f.eventSummary ?? f.summary ?? ''),
  );
  if (revenueUpdates.length > 0) {
    signals.push({
      label:  'Revenue / Operational Announcements',
      detail: `${revenueUpdates.length} revenue- or milestone-related announcement${revenueUpdates.length > 1 ? 's' : ''} filed in the past 12 months, suggesting commercial traction.`,
    });
  } else if (operationalUpdates.length > 0) {
    signals.push({
      label:  'Active Operational Updates',
      detail: `${operationalUpdates.length} operational update${operationalUpdates.length > 1 ? 's' : ''} filed in the past 12 months, indicating ongoing business activity.`,
    });
  }

  // Partnerships
  const partnerships = filings.filter(
    f => f.eventType === 'partnership' && f.filedAt >= cutoffStr,
  );
  if (partnerships.length > 0) {
    signals.push({
      label:  'Partnership Activity',
      detail: `${partnerships.length} partnership or agreement announcement${partnerships.length > 1 ? 's' : ''} in the past 12 months, indicating business development activity.`,
    });
  }

  // Product launches
  const launches = filings.filter(
    f => f.eventType === 'product_launch' && f.filedAt >= cutoffStr,
  );
  if (launches.length > 0) {
    signals.push({
      label:  'Product Launch Activity',
      detail: `${launches.length} product launch or regulatory approval announcement${launches.length > 1 ? 's' : ''} in the past 12 months.`,
    });
  }

  // Dilution stabilizing
  const recentRates = trend.periodicGrowthRates.slice(-2);
  if (recentRates.length >= 2 && recentRates.every(r => r < 5) && (trend.totalGrowthPct ?? 0) > 10) {
    signals.push({
      label:  'Dilution Appears to Be Stabilizing',
      detail: 'Share count growth rates in the most recent periods have fallen below 5%, suggesting dilution may be slowing even if the total float remains elevated.',
    });
  }

  // Debt reduction: decreasing outstanding balances over time
  const reportsOldestFirst = [...filings]
    .filter(f => f.financingReport && f.financingReport.convertibleDebt.length > 0)
    .sort((a, b) => a.filedAt.localeCompare(b.filedAt));
  if (reportsOldestFirst.length >= 2) {
    const oldTotal = reportsOldestFirst[0].financingReport!.convertibleDebt
      .reduce((s, n) => s + (n.outstandingBalance ?? n.principalAmount ?? 0), 0);
    const newTotal = reportsOldestFirst[reportsOldestFirst.length - 1].financingReport!.convertibleDebt
      .reduce((s, n) => s + (n.outstandingBalance ?? n.principalAmount ?? 0), 0);
    if (newTotal < oldTotal * 0.75) {
      signals.push({
        label:  'Convertible Debt Reduction',
        detail: `Outstanding convertible debt appears to have decreased from ${fmt$(oldTotal)} to ${fmt$(newTotal)} across the measured periods, suggesting payoff or conversion without new issuance at the same pace.`,
      });
    }
  }

  // Uplisting mentions in event summaries
  const uplisting = filings.find(f =>
    /uplisting|nasdaq|nyse|uplist/i.test(f.eventSummary ?? f.summary ?? ''),
  );
  if (uplisting) {
    signals.push({
      label:  'Uplisting Activity Mentioned',
      detail: `At least one filing references uplisting or exchange listing efforts, which if successful would require improved financial health and transparency.`,
    });
  }

  return signals;
}

// ─── Dilution risk classification ─────────────────────────────────────────────

function deriveDilutionRisk(
  profile: AggregatedFinancingProfile,
  trend:   ShareStructureTrend,
): DilutionRiskLevel {
  const latestShares = trend.periods.length > 0
    ? trend.periods[trend.periods.length - 1].sharesOutstanding
    : 0;

  let score = 0;

  score += profile.toxicNoteCount    * 4;
  score += (profile.noFloorNoteCount - profile.toxicNoteCount) * 2;
  score += (profile.resetNoteCount   - profile.toxicNoteCount) * 1;
  if (profile.hasActiveEloc) score += 2;
  else if (profile.totalEquityFacilityCommitment > 0) score += 1;
  if (latestShares >= 10_000_000_000) score += 3;
  else if (latestShares >= 1_000_000_000) score += 1;
  if ((trend.totalGrowthPct ?? 0) >= 25)  score += 2;
  else if ((trend.totalGrowthPct ?? 0) >= 10) score += 1;
  if (trend.isAccelerating) score += 1;
  if (profile.recentFinancingEvents >= 4) score += 1;

  // Warrant overhang — large outstanding warrant positions dilute even without conversion
  if (profile.totalWarrantShares >= 500_000_000)     score += 2;
  else if (profile.totalWarrantShares >= 50_000_000) score += 1;

  // Unresolved extraction warnings indicate uncertainty — floor at moderate
  // because the true risk cannot be confirmed when extraction failed materially
  if (profile.extractionWarningCount >= 5) score += 1;

  // Hard floors
  let floor: DilutionRiskLevel = 'low';
  // An active equity facility, committed notes, or a large share count
  // all make 'low' impossible to sustain
  if (profile.totalConvertiblePrincipal > 0 || profile.hasActiveEloc ||
      latestShares >= 1_000_000_000 || profile.totalEquityFacilityCommitment > 0 ||
      profile.totalWarrantShares >= 100_000_000 || profile.extractionWarningCount >= 3)
    floor = 'moderate';
  if (latestShares >= 10_000_000_000) floor = 'high';
  if (profile.toxicNoteCount > 0)     floor = 'high';

  const fromScore: DilutionRiskLevel =
    score >= 8 ? 'severe' :
    score >= 4 ? 'high' :
    score >= 2 ? 'moderate' : 'low';

  const ORDER: Record<DilutionRiskLevel, number> = { low: 0, moderate: 1, high: 2, severe: 3 };
  return ORDER[fromScore] >= ORDER[floor] ? fromScore : floor;
}

// ─── Financing profile label ──────────────────────────────────────────────────

function deriveFinancingProfileLabel(profile: AggregatedFinancingProfile): string {
  const hasEquity      = profile.hasActiveEloc || profile.totalEquityFacilityCommitment > 0;
  const hasConvertible = profile.totalConvertiblePrincipal > 0;
  const rpLoans        = profile.totalRelatedPartyLoans ?? 0;
  // RP loans only factor into "Mixed" when material (≥ $1M). Smaller balances are disclosed
  // separately but do not change the primary financing classification.
  const hasSignificantRp = rpLoans >= 1_000_000;
  const hasAnyRp         = rpLoans > 0;

  if (profile.toxicNoteCount > 0 && hasEquity)    return 'Mixed external financing';
  if (profile.toxicNoteCount > 0)                  return 'Convertible debt dependent';
  if (hasEquity && hasConvertible)                  return 'Mixed external financing';
  if (hasEquity && hasSignificantRp)                return 'Mixed external financing';
  if (hasEquity)                                    return 'Equity facility dependent';
  if (hasConvertible && hasSignificantRp)           return 'Mixed external financing';
  if (hasConvertible)                               return 'Convertible debt dependent';
  if (hasAnyRp)                                     return 'Related-party funded';
  if (profile.recentFinancingEvents > 0)            return 'Active financing (terms not extracted)';
  return 'No structured financing identified';
}

// ─── Executive summary ────────────────────────────────────────────────────────

function buildExecutiveSummary(
  ticker:   string,
  risk:     DilutionRiskLevel,
  profile:  AggregatedFinancingProfile,
  trend:    ShareStructureTrend,
  risks:    CompanyRiskFactor[],
  signals:  CompanyPositiveSignal[],
): string {
  const sentences: string[] = [];

  // 1. Financing overview
  if (profile.totalConvertiblePrincipal > 0 || profile.totalEquityFacilityCommitment > 0) {
    const items: string[] = [];
    if (profile.totalConvertiblePrincipal > 0) {
      const noteDesc = profile.toxicNoteCount > 0 ? 'toxic variable-rate convertible notes'
        : profile.noFloorNoteCount > 0 ? 'variable-rate convertible notes (no floor price)'
        : 'convertible notes';
      items.push(`${noteDesc} (${fmt$(profile.totalConvertiblePrincipal)} principal)`);
    }
    if (profile.totalEquityFacilityCommitment > 0) {
      items.push(`an equity ${profile.hasActiveEloc ? 'line actively being drawn' : 'line of credit'} (${fmt$(profile.totalEquityFacilityCommitment)} committed)`);
    }
    if ((profile.totalRelatedPartyLoans ?? 0) > 0) {
      items.push(`related-party loans (${fmt$(profile.totalRelatedPartyLoans!)})`);
    }
    sentences.push(`${ticker} has financed operations primarily through ${items.join(' and ')}.`);
  } else if (profile.recentFinancingEvents > 0) {
    sentences.push(`${ticker} has filed ${profile.recentFinancingEvents} financing-related disclosures in the past 12 months, though structured terms could not be fully extracted from quarterly or annual reports.`);
  } else {
    sentences.push(`${ticker} shows no structured convertible financing in the analyzed filings, suggesting either a clean balance sheet or data limitations in the retrieved filing set.`);
  }

  // 2. Dilution trajectory
  if (trend.periods.length >= 2) {
    sentences.push(trend.narrative);
  }

  // 3. Top risk
  const topRisk = risks[0];
  if (topRisk) {
    const severity = topRisk.severity === 'critical' ? 'The most critical risk'
      : topRisk.severity === 'high' ? 'The primary risk'
      : 'A notable risk';
    sentences.push(`${severity} is ${topRisk.label.toLowerCase()}: ${topRisk.detail}`);
  }

  // 4. Secondary risk (if meaningfully different from first)
  if (risks.length >= 2 && risks[1].severity !== 'low') {
    sentences.push(`Additionally, ${risks[1].label.toLowerCase()}: ${risks[1].detail}`);
  }

  // 5. Positive signals
  if (signals.length > 0) {
    const top = signals[0];
    const more = signals.length > 1 ? ` ${signals.length - 1} further positive indicator${signals.length > 2 ? 's were' : ' was'} also identified.` : '';
    sentences.push(`On the positive side: ${top.detail}${more}`);
  } else if (risk === 'low') {
    sentences.push('No significant risk factors were identified, and the company appears to be operating without reliance on dilutive financing instruments.');
  }

  // 6. Investor watchpoint
  if (risk === 'severe' || risk === 'high') {
    const watchItems: string[] = [];
    if (profile.toxicNoteCount > 0) watchItems.push('the pace of note conversions and any new financing announcements');
    if (profile.hasActiveEloc) watchItems.push('draws on the equity facility and resulting share issuances');
    if ((trend.totalGrowthPct ?? 0) > 25) watchItems.push('the trajectory of shares outstanding across future quarterly reports');
    sentences.push(`Investors should closely monitor ${watchItems.join(', ') || 'all financing activity and share count changes'} before establishing or maintaining a position.`);
  } else if (risk === 'moderate') {
    sentences.push('Investors should review the convertible note terms carefully and track whether the share count stabilizes or continues to grow in upcoming filings.');
  } else {
    sentences.push('Investors should continue monitoring for any new convertible or dilutive financing disclosures in future filings.');
  }

  return sentences.join(' ');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a company-level intelligence object from all normalized filings.
 *
 * @param ticker   Ticker symbol (used for display only; not for any fetch)
 * @param filings  All NormalizedFiling records for the ticker, in any order
 */
export function generateCompanyIntelligence(
  ticker:  string,
  filings: NormalizedFiling[],
): CompanyIntelligence {
  if (filings.length === 0) {
    return {
      ticker,
      generatedAt:     new Date().toISOString(),
      filingsAnalyzed: 0,
      overview: {
        dilutionRisk:     'low',
        financingProfile: 'No data',
      },
      shareStructureTrend: {
        periods: [], periodicGrowthRates: [], isAccelerating: false,
        narrative: 'No filings available.',
      },
      financingProfile: {
        totalConvertiblePrincipal: 0, totalConvertibleOutstanding: 0,
        totalEquityFacilityCommitment: 0, totalEquityFacilityDrawn: 0,
        totalWarrantShares: 0, totalRelatedPartyLoans: undefined,
        toxicNoteCount: 0, noFloorNoteCount: 0, resetNoteCount: 0,
        hasActiveEloc: false, recentFinancingEvents: 0,
        narrative: 'No filings available.',
        relatedPartyDataWarnings: [],
        facilityAmbiguityWarnings: [],
        extractionWarningCount: 0,
      },
      keyRisks:        [],
      positiveSignals: [],
      executiveSummary: 'No filings were available to analyze.',
    };
  }

  const trend   = buildShareStructureTrend(filings);
  const profile = buildFinancingProfile(ticker, filings);
  const risk    = deriveDilutionRisk(profile, trend);
  const risks   = buildKeyRisks(profile, trend, filings);
  const signals = buildPositiveSignals(filings, trend, profile);

  // Latest share structure from most recent filing with data
  const latestWithShares = [...filings]
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt))
    .find(f => f.shareStructure?.sharesOutstanding ?? f.otcShareStructure?.sharesOutstanding);
  const latestSharesOutstanding = latestWithShares?.shareStructure?.sharesOutstanding
    ?? latestWithShares?.otcShareStructure?.sharesOutstanding;
  const latestAuthorizedShares  = latestWithShares?.shareStructure?.sharesAuthorized
    ?? latestWithShares?.otcShareStructure?.authorizedShares;

  const latestFiling = [...filings].sort((a, b) => b.filedAt.localeCompare(a.filedAt))[0];

  return {
    ticker,
    generatedAt:     new Date().toISOString(),
    filingsAnalyzed: filings.length,

    overview: {
      dilutionRisk:            risk,
      financingProfile:        deriveFinancingProfileLabel(profile),
      latestSharesOutstanding,
      latestAuthorizedShares,
      latestFilingDate:        latestFiling?.filedAt,
      latestFormType:          latestFiling?.formType,
    },

    shareStructureTrend:  trend,
    financingProfile:     profile,
    keyRisks:             risks,
    positiveSignals:      signals,
    executiveSummary:     buildExecutiveSummary(ticker, risk, profile, trend, risks, signals),
  };
}
