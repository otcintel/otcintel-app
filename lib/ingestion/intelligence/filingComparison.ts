/**
 * Filing comparison engine — 10-K / 10-Q period-over-period diff
 *
 * For every 10-K and 10-Q with a financingReport, locates the previous
 * filing of the same type and generates a "CHANGES SINCE PRIOR REPORT"
 * section that is injected immediately after the Executive Summary in
 * the report text.
 *
 * The comparison covers:
 *   • Shares outstanding / authorized / preferred
 *   • Total convertible debt outstanding
 *   • New and retired individual notes
 *   • Equity facilities (new, draw changes)
 *   • Total warrant exposure
 *   • Related-party loan balances
 *   • Common and preferred stock issuances
 *   • Debt conversion activity
 *
 * All logic is pure computation over NormalizedFiling objects — no external
 * calls, no mutations except the targeted reportText injection.
 *
 * @module intelligence/filingComparison
 */

import type {
  NormalizedFiling,
  ConvertibleNote,
} from '../types';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt$(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000)         return `$${Math.round(n / 1_000)}K`;
  return `$${n.toLocaleString()}`;
}

function fmtN(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000)         return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString();
}

function fmtShares(n: number): string {
  return `${fmtN(n)} shares`;
}

function pctChange(current: number, prior: number): string {
  const p = ((current - prior) / prior) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// ─── Filing-type normalizer ───────────────────────────────────────────────────

function baseFormType(formType: string): '10-K' | '10-Q' | null {
  if (formType === '10-K' || formType === '10-K/A') return '10-K';
  if (formType === '10-Q' || formType === '10-Q/A') return '10-Q';
  return null;
}

// ─── Share-count resolvers ────────────────────────────────────────────────────
// Priority: SEC shareStructure > financingReport dilution summary > OTC fallback

function getSharesOutstanding(f: NormalizedFiling): number | undefined {
  return f.shareStructure?.sharesOutstanding
    ?? f.financingReport?.dilutionSummary.sharesOutstandingEnd
    ?? f.otcShareStructure?.sharesOutstanding;
}

function getSharesAuthorized(f: NormalizedFiling): number | undefined {
  return f.shareStructure?.sharesAuthorized
    ?? f.otcShareStructure?.authorizedShares;
}

function getPreferredShares(f: NormalizedFiling): number | undefined {
  return f.shareStructure?.preferredSharesOutstanding;
}

// ─── Note identity matching ───────────────────────────────────────────────────
// Mirror of the parser's sameNote logic — same ±2% principal window,
// investor-name conflict check, and investor+maturity/rate fallbacks.

function notesMatch(a: ConvertibleNote, b: ConvertibleNote): boolean {
  const aN = a.investorName?.toLowerCase().trim();
  const bN = b.investorName?.toLowerCase().trim();
  const namesConflict = aN && bN && aN !== bN;

  if (a.principalAmount && b.principalAmount) {
    const diff = Math.abs(a.principalAmount - b.principalAmount);
    const base = Math.min(a.principalAmount, b.principalAmount);
    if (diff / base < 0.02) return !namesConflict;
  }
  if (aN && bN && aN === bN) {
    if (a.maturityDate && b.maturityDate && a.maturityDate === b.maturityDate) return true;
    if (a.interestRate && b.interestRate && Math.abs(a.interestRate - b.interestRate) < 0.005) return true;
  }
  return false;
}

// ─── Prior-filing locator ─────────────────────────────────────────────────────

/**
 * Returns the most recent filing of the same base form type (10-K or 10-Q)
 * filed before `current`, or undefined if none exists.
 */
export function findPriorFiling(
  allFilings: NormalizedFiling[],
  current:    NormalizedFiling,
): NormalizedFiling | undefined {
  const type = baseFormType(current.formType);
  if (!type) return undefined;

  return [...allFilings]
    .filter(f =>
      f.accessionNumber !== current.accessionNumber &&
      baseFormType(f.formType) === type          &&
      f.filedAt < current.filedAt,
    )
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt))[0];
}

// ─── Comparison section generator ────────────────────────────────────────────

/**
 * Compares `current` against `prior` and returns the text of a
 * "CHANGES SINCE PRIOR REPORT" section (bullet list, analyst prose).
 * Only meaningful changes above per-metric thresholds are included.
 */
export function compareFilings(
  current: NormalizedFiling,
  prior:   NormalizedFiling,
): string {
  const bullets: string[] = [];
  const curR = current.financingReport;
  const priR = prior.financingReport;

  // ── Shares outstanding ────────────────────────────────────────────────────
  const curSO = getSharesOutstanding(current);
  const priSO = getSharesOutstanding(prior);
  if (curSO && priSO && curSO !== priSO) {
    const chgPct = ((curSO - priSO) / priSO) * 100;
    if (Math.abs(chgPct) >= 1) {
      const dir   = curSO > priSO ? 'increased' : 'decreased';
      const delta = Math.abs(curSO - priSO);
      const sign  = curSO > priSO ? '+' : '-';
      bullets.push(
        `Shares outstanding ${dir} from ${fmtN(priSO)} to ${fmtN(curSO)} ` +
        `(${sign}${fmtN(delta)}, ${pctChange(curSO, priSO)}).`,
      );
    }
  } else if (curSO && !priSO) {
    bullets.push(`Shares outstanding: ${fmtShares(curSO)} (prior period data unavailable).`);
  }

  // ── Authorized shares ─────────────────────────────────────────────────────
  const curAuth = getSharesAuthorized(current);
  const priAuth = getSharesAuthorized(prior);
  if (curAuth && priAuth && curAuth !== priAuth) {
    const dir = curAuth > priAuth ? 'increased' : 'decreased';
    bullets.push(
      `Authorized share count ${dir} from ${fmtN(priAuth)} to ${fmtN(curAuth)}.`,
    );
  }

  // ── Preferred shares outstanding ──────────────────────────────────────────
  const curPref = getPreferredShares(current);
  const priPref = getPreferredShares(prior);
  if (curPref && priPref && curPref !== priPref) {
    const dir = curPref > priPref ? 'increased' : 'decreased';
    bullets.push(
      `Preferred shares outstanding ${dir} from ${fmtN(priPref)} to ${fmtN(curPref)}.`,
    );
  } else if (curPref && !priPref) {
    bullets.push(`Preferred shares outstanding: ${fmtShares(curPref)} (none in prior period).`);
  } else if (!curPref && priPref) {
    bullets.push(`Preferred shares outstanding reduced to nil (was ${fmtShares(priPref)}).`);
  }

  // All remaining comparisons require both periods to have a FinancingReport
  if (curR && priR) {

    // ── Total convertible debt outstanding ──────────────────────────────────
    const curDebt = curR.convertibleDebt.reduce((s, n) => s + (n.outstandingBalance ?? n.principalAmount ?? 0), 0);
    const priDebt = priR.convertibleDebt.reduce((s, n) => s + (n.outstandingBalance ?? n.principalAmount ?? 0), 0);
    const debtDelta = Math.abs(curDebt - priDebt);
    const debtPctChg = priDebt > 0 ? ((curDebt - priDebt) / priDebt) * 100 : (curDebt > 0 ? 100 : 0);

    if (debtDelta >= 5_000 || (priDebt > 0 && Math.abs(debtPctChg) >= 5)) {
      if (priDebt === 0 && curDebt > 0) {
        bullets.push(`Convertible debt of ${fmt$(curDebt)} was identified (none in prior period).`);
      } else if (curDebt === 0 && priDebt > 0) {
        bullets.push(`Convertible debt was fully retired or converted (was ${fmt$(priDebt)}).`);
      } else if (curDebt !== priDebt) {
        const dir  = curDebt > priDebt ? 'increased' : 'decreased';
        const sign = curDebt > priDebt ? '+' : '-';
        bullets.push(
          `Convertible debt ${dir} from ${fmt$(priDebt)} to ${fmt$(curDebt)} ` +
          `(${sign}${fmt$(debtDelta)}, ${pctChange(curDebt, priDebt)}).`,
        );
      }
    }

    // ── New notes (in current, absent from prior) ───────────────────────────
    const newNotes = curR.convertibleDebt.filter(n =>
      !priR.convertibleDebt.some(p => notesMatch(p, n)),
    );
    for (const n of newNotes) {
      const principal = n.principalAmount
        ? fmt$(n.principalAmount)
        : n.outstandingBalance
        ? fmt$(n.outstandingBalance)
        : 'undisclosed principal';
      const lender   = n.investorName ? ` with ${n.investorName}` : '';
      const rate     = n.interestRate  ? ` at ${(n.interestRate * 100).toFixed(0)}% interest` : '';
      const maturity = n.maturityDate  ? `, maturing ${n.maturityDate}` : '';
      bullets.push(
        `New convertible note of ${principal}${lender}${rate}${maturity} entered into this period.`,
      );
    }

    // ── Retired notes (in prior, absent from current) ───────────────────────
    const retiredNotes = priR.convertibleDebt.filter(p =>
      !curR.convertibleDebt.some(n => notesMatch(p, n)),
    );
    for (const p of retiredNotes) {
      const principal = p.principalAmount ? fmt$(p.principalAmount) : 'undisclosed principal';
      const lender    = p.investorName ? ` (${p.investorName})` : '';
      bullets.push(
        `Convertible note of ${principal}${lender} was retired or fully converted since the prior period.`,
      );
    }

    // ── Equity facilities — state-aware comparison ────────────────────────
    const FACILITY_LABEL: Record<string, string> = {
      eloc: 'Equity Line of Credit (ELOC)', efa: 'Equity Financing Agreement (EFA)',
      equity_line: 'Equity Line of Credit', variable_note: 'Variable-Rate Note Facility',
      other: 'Equity Facility',
    };

    function sameFacilityForComparison(
      a: { counterpartyName?: string; facilitySize?: number },
      b: { counterpartyName?: string; facilitySize?: number },
    ): boolean {
      if (a.counterpartyName && b.counterpartyName &&
          a.counterpartyName.toLowerCase() === b.counterpartyName.toLowerCase()) return true;
      if (a.facilitySize && b.facilitySize) {
        return Math.abs(a.facilitySize - b.facilitySize) / Math.min(a.facilitySize, b.facilitySize) < 0.05;
      }
      return false;
    }

    for (const f of curR.equityFacilities) {
      const prior = priR.equityFacilities.find(p => sameFacilityForComparison(f, p));
      const typeStr  = FACILITY_LABEL[f.facilityType ?? 'other'];
      const name     = f.counterpartyName ?? typeStr;

      if (!prior) {
        // New facility this period
        const sizeStr  = f.facilitySize ? ` of ${fmt$(f.facilitySize)}` : '';
        const partyStr = f.counterpartyName ? ` with ${f.counterpartyName}` : '';
        bullets.push(`[NEW FACILITY] ${typeStr}${sizeStr} entered into${partyStr}.`);
        continue;
      }

      // Facility existed before — determine what changed
      const sizeChanged = prior.facilitySize && f.facilitySize &&
        Math.abs(f.facilitySize - prior.facilitySize) / prior.facilitySize >= 0.05;
      const typeChanged = prior.facilityType && f.facilityType && prior.facilityType !== f.facilityType;
      const drawDelta   = f.drawnAmount != null && prior.drawnAmount != null
        ? f.drawnAmount - prior.drawnAmount : null;

      if (sizeChanged && f.facilitySize && prior.facilitySize) {
        const dir = f.facilitySize > prior.facilitySize ? 'expanded' : 'reduced';
        bullets.push(
          `[AMENDED FACILITY] ${name} — commitment ${dir} from ${fmt$(prior.facilitySize)} to ${fmt$(f.facilitySize)}.`,
        );
      } else if (typeChanged) {
        bullets.push(`[AMENDED FACILITY] ${name} — facility type changed from ${prior.facilityType} to ${f.facilityType}.`);
      }

      if (drawDelta != null && Math.abs(drawDelta) >= 5_000) {
        const dir  = drawDelta > 0 ? 'increased' : 'decreased';
        const sign = drawDelta > 0 ? '+' : '-';
        const fromStr = prior.drawnAmount != null ? `from ${fmt$(prior.drawnAmount)} ` : '';
        bullets.push(
          `[FACILITY DRAW] ${name} — draws ${dir} ${fromStr}to ${fmt$(f.drawnAmount ?? 0)} (${sign}${fmt$(Math.abs(drawDelta))}).`,
        );
      }
    }

    // Facilities in prior but absent from current — likely terminated or not disclosed
    for (const p of priR.equityFacilities) {
      const stillPresent = curR.equityFacilities.some(f => sameFacilityForComparison(f, p));
      if (!stillPresent) {
        const typeStr  = FACILITY_LABEL[p.facilityType ?? 'other'];
        const name     = p.counterpartyName ?? typeStr;
        const sizeStr  = p.facilitySize ? ` (${fmt$(p.facilitySize)} commitment)` : '';
        bullets.push(
          `[FACILITY TERMINATED?] ${name}${sizeStr} disclosed in the prior period is absent from this filing — ` +
          `it may have expired, terminated, or been reclassified.`,
        );
      }
    }

    // ── Warrants — total share exposure ───────────────────────────────────
    const curWS = curR.warrants.reduce((s, w) => s + (w.warrantShares ?? 0), 0);
    const priWS = priR.warrants.reduce((s, w) => s + (w.warrantShares ?? 0), 0);
    const wsDelta = Math.abs(curWS - priWS);
    if (wsDelta >= 100_000 || (priWS > 0 && wsDelta / priWS >= 0.01)) {
      if (priWS === 0 && curWS > 0) {
        bullets.push(`Warrants to purchase ${fmtShares(curWS)} were disclosed (none in prior period).`);
      } else if (curWS === 0 && priWS > 0) {
        bullets.push(`All warrants (${fmtShares(priWS)}) appear to have expired or been exercised.`);
      } else {
        const dir  = curWS > priWS ? 'increased' : 'decreased';
        const sign = curWS > priWS ? '+' : '-';
        bullets.push(
          `Outstanding warrant shares ${dir} by ${fmtShares(wsDelta)} ` +
          `(from ${fmtN(priWS)} to ${fmtN(curWS)}).`,
        );
      }
    }

    // ── Related-party loans ───────────────────────────────────────────────
    const curRL = curR.relatedPartyTransactions
      .filter(t => t.transactionType === 'loan')
      .reduce((s, t) => s + (t.amount ?? 0), 0);
    const priRL = priR.relatedPartyTransactions
      .filter(t => t.transactionType === 'loan')
      .reduce((s, t) => s + (t.amount ?? 0), 0);
    const rlDelta = Math.abs(curRL - priRL);
    if (rlDelta >= 5_000) {
      if (priRL === 0 && curRL > 0) {
        bullets.push(`Related-party loans of ${fmt$(curRL)} were disclosed (none in prior period).`);
      } else if (curRL === 0 && priRL > 0) {
        bullets.push(`Related-party loans (previously ${fmt$(priRL)}) were retired or not disclosed.`);
      } else {
        const dir = curRL > priRL ? 'increased' : 'decreased';
        bullets.push(`Related-party loan balances ${dir} by ${fmt$(rlDelta)} (from ${fmt$(priRL)} to ${fmt$(curRL)}).`);
      }
    }

    // ── Common stock issuances ────────────────────────────────────────────
    const curCI    = curR.equityIssuances.filter(e => e.issuanceType !== 'preferred');
    const priCI    = priR.equityIssuances.filter(e => e.issuanceType !== 'preferred');
    const curCProc = curCI.reduce((s, e) => s + (e.grossProceeds ?? 0), 0);
    const curCSh   = curCI.reduce((s, e) => s + (e.sharesIssued   ?? 0), 0);
    if (curCI.length > 0) {
      if (priCI.length === 0) {
        const procStr = curCProc > 0 ? ` (${fmt$(curCProc)} in gross proceeds)` : '';
        const shrStr  = curCSh   > 0 ? `, ${fmtShares(curCSh)} issued` : '';
        bullets.push(`Common stock issuances occurred this period${procStr}${shrStr} — no comparable activity in the prior period.`);
      } else if (curCProc > 0) {
        const priCProc = priCI.reduce((s, e) => s + (e.grossProceeds ?? 0), 0);
        const delta    = Math.abs(curCProc - priCProc);
        if (delta >= 5_000) {
          const dir = curCProc > priCProc ? 'increased' : 'decreased';
          bullets.push(`Gross proceeds from common stock issuances ${dir} from ${fmt$(priCProc)} to ${fmt$(curCProc)}.`);
        }
      }
    } else if (priCI.length > 0) {
      bullets.push('No common stock issuances were recorded this period (prior period had issuance activity).');
    }

    // ── Preferred stock issuances ─────────────────────────────────────────
    const curPI    = curR.equityIssuances.filter(e => e.issuanceType === 'preferred');
    const priPI    = priR.equityIssuances.filter(e => e.issuanceType === 'preferred');
    const curPProc = curPI.reduce((s, e) => s + (e.grossProceeds ?? 0), 0);
    if (curPI.length > 0 && priPI.length === 0) {
      bullets.push(
        curPProc > 0
          ? `Preferred stock issuances of ${fmt$(curPProc)} were recorded this period (no preferred activity in prior period).`
          : 'Preferred stock was issued this period (no preferred activity in prior period).',
      );
    } else if (curPI.length === 0 && priPI.length > 0) {
      bullets.push('No preferred stock activity was recorded this period (prior period had preferred issuances).');
    }

    // ── Debt conversions ──────────────────────────────────────────────────
    const curCD  = curR.conversions.reduce((s, c) => s + (c.debtConverted ?? 0), 0);
    const curCSI = curR.conversions.reduce((s, c) => s + (c.sharesIssued  ?? 0), 0);
    const priCD  = priR.conversions.reduce((s, c) => s + (c.debtConverted ?? 0), 0);
    if (curCD > 0 && curCSI > 0) {
      if (priCD === 0) {
        bullets.push(
          `Debt-to-equity conversions commenced this period: ${fmt$(curCD)} converted into ${fmtShares(curCSI)}.`,
        );
      } else {
        const convPct = ((curCD - priCD) / priCD) * 100;
        if (Math.abs(convPct) >= 15) {
          const dir = curCD > priCD ? 'accelerated' : 'slowed';
          bullets.push(
            `Conversion activity ${dir}: ${fmt$(curCD)} converted this period vs. ${fmt$(priCD)} in the prior period.`,
          );
        }
      }
    } else if (curCD === 0 && priCD > 0) {
      bullets.push(`No debt conversions were recorded this period (prior period: ${fmt$(priCD)} converted).`);
    }

  } // end if (curR && priR)

  if (bullets.length === 0) {
    bullets.push('No significant changes detected versus the prior filing of the same type.');
  }

  const priorLabel = `${prior.formType} filed ${prior.filedAt}`;
  return `Compared to ${priorLabel}:\n\n${bullets.map(b => `• ${b}`).join('\n')}`;
}

// ─── Report text injection ────────────────────────────────────────────────────

const SECTION_DIVIDER = '\n\n' + '─'.repeat(60) + '\n\n';

/**
 * Injects a "CHANGES SINCE PRIOR REPORT" section into an existing report text
 * immediately after the Executive Summary (section 1) and before section 2.
 * If no divider is found (e.g. the report is a short fallback message) the
 * comparison section is prepended.
 */
function injectComparisonSection(reportText: string, comparisonBody: string): string {
  const section = `CHANGES SINCE PRIOR REPORT\n\n${comparisonBody}`;
  const firstDiv = reportText.indexOf(SECTION_DIVIDER);
  if (firstDiv === -1) {
    return `${section}${SECTION_DIVIDER}${reportText}`;
  }
  const insertAt = firstDiv + SECTION_DIVIDER.length;
  return (
    reportText.slice(0, insertAt) +
    section +
    SECTION_DIVIDER +
    reportText.slice(insertAt)
  );
}

// ─── Financing timeline builder ───────────────────────────────────────────────

/**
 * Derives a human-readable period label from a filing's formType and filedAt.
 * Examples: "Q3 2024 (10-Q, filed 2024-11-14)", "FY 2023 (10-K, filed 2024-03-28)"
 */
function periodLabel(f: NormalizedFiling): string {
  const base = baseFormType(f.formType);
  const year = f.filedAt.slice(0, 4);
  const mm   = parseInt(f.filedAt.slice(5, 7), 10);

  let period: string;
  if (base === '10-K') {
    period = `FY ${year}`;
  } else {
    // Approximate fiscal quarter from filing month: Q1 filings ~May, Q2 ~Aug, Q3 ~Nov, Q4/10-K
    const q = mm <= 5 ? 'Q1' : mm <= 8 ? 'Q2' : mm <= 11 ? 'Q3' : 'Q4';
    period = `${q} ${year}`;
  }
  return `${period} (${f.formType}, filed ${f.filedAt})`;
}

/**
 * Builds a Financing Timeline section that reconstructs all identified
 * financing events chronologically across the provided set of filings.
 *
 * Instrument tracking:
 *   • Convertible notes — first appearance as NEW; subsequent periods emit
 *     balance/status updates only if something materially changed.
 *   • Equity facilities — state-aware: NEW / AMENDED / EXPANDED / DRAWN /
 *     TERMINATED rather than treating every appearance as a new entry.
 *   • Equity issuances, conversions, warrants — period-specific events,
 *     always included in the period they occurred.
 *   • Periods with no events are omitted.
 *
 * Returns the text of a "14. FINANCING TIMELINE" section, or an empty string
 * if fewer than 2 qualifying filings are available.
 */
export function buildFinancingTimeline(filings: NormalizedFiling[]): string {
  const qualifying = [...filings]
    .filter(f => ['10-K', '10-K/A', '10-Q', '10-Q/A'].includes(f.formType) && f.financingReport)
    .sort((a, b) => a.filedAt.localeCompare(b.filedAt));

  if (qualifying.length < 2) return '';

  const FACILITY_TYPE_LABEL: Record<string, string> = {
    eloc: 'ELOC', efa: 'EFA', equity_line: 'Equity Line',
    variable_note: 'Variable-Rate Facility', other: 'Equity Facility',
  };

  // ── Note identity tracking ────────────────────────────────────────────────
  type NoteRecord = {
    principalAmount?: number;
    investorName?:    string;
    interestRate?:    number;
    maturityDate?:    string;
    lastBalance?:     number;
  };
  const seenNotes: NoteRecord[] = [];

  function findSeenNote(n: ConvertibleNote): NoteRecord | undefined {
    return seenNotes.find(s => {
      if (s.principalAmount && n.principalAmount) {
        const diff = Math.abs(s.principalAmount - n.principalAmount);
        const base = Math.min(s.principalAmount, n.principalAmount);
        if (diff / base < 0.02) {
          const sN = s.investorName?.toLowerCase();
          const nN = n.investorName?.toLowerCase();
          return !sN || !nN || sN === nN;
        }
      }
      if (s.investorName && n.investorName &&
          s.investorName.toLowerCase() === n.investorName.toLowerCase()) {
        if ((s.maturityDate && s.maturityDate === n.maturityDate) ||
            (s.interestRate && n.interestRate && Math.abs(s.interestRate - n.interestRate) < 0.005)) {
          return true;
        }
      }
      return false;
    });
  }

  // ── Facility state tracking ───────────────────────────────────────────────
  type FacilityRecord = {
    counterpartyName?: string;
    facilitySize?:     number;
    drawnAmount?:      number;
    facilityType?:     string;
  };
  const seenFacilities: FacilityRecord[] = [];

  function findSeenFacility(f: { counterpartyName?: string; facilitySize?: number }): FacilityRecord | undefined {
    return seenFacilities.find(s => {
      if (s.counterpartyName && f.counterpartyName &&
          s.counterpartyName.toLowerCase() === f.counterpartyName.toLowerCase()) return true;
      if (s.facilitySize && f.facilitySize) {
        return Math.abs(s.facilitySize - f.facilitySize) / Math.min(s.facilitySize, f.facilitySize) < 0.05;
      }
      return false;
    });
  }

  const blocks: string[] = [];

  for (const filing of qualifying) {
    const r = filing.financingReport!;
    const events: string[] = [];

    // ── Convertible notes ────────────────────────────────────────────────
    for (const n of r.convertibleDebt.filter(n => n._section !== 'subsequent_events')) {
      const existing = findSeenNote(n);

      if (!existing) {
        // First time this note appears
        seenNotes.push({
          principalAmount: n.principalAmount,
          investorName:    n.investorName,
          interestRate:    n.interestRate,
          maturityDate:    n.maturityDate,
          lastBalance:     n.outstandingBalance ?? n.principalAmount,
        });
        const principal   = n.principalAmount ? fmt$(n.principalAmount)
          : n.outstandingBalance ? fmt$(n.outstandingBalance) : 'undisclosed principal';
        const lender      = n.investorName ? ` with ${n.investorName}` : '';
        const rate        = n.interestRate ? ` at ${(n.interestRate * 100).toFixed(0)}%` : '';
        const maturity    = n.maturityDate ? `, matures ${n.maturityDate}` : '';
        const discountStr = n.discountRate
          ? ` [${(n.discountRate * 100).toFixed(0)}% discount to VWAP${n.hasFloorPrice ? ', floored' : ', no floor'}${n.hasResetProvisions ? ', RESET PROVISIONS' : ''}]`
          : n.fixedConversionPrice
          ? ` [fixed conversion @ $${n.fixedConversionPrice}]`
          : '';
        events.push(`→ [NEW NOTE] ${principal}${lender}${rate}${maturity}${discountStr}.`);
      } else {
        // Note seen before — emit update only if balance changed materially
        const curBalance = n.outstandingBalance ?? n.principalAmount;
        const prevBalance = existing.lastBalance;
        if (curBalance != null && prevBalance != null) {
          const delta = prevBalance - curBalance;
          const pct   = delta / prevBalance;
          if (pct >= 0.02 && delta >= 1_000) {
            const lender = n.investorName ? ` (${n.investorName})` : '';
            events.push(
              `→ [NOTE UPDATE] ${lender ? lender.slice(2, -1) : 'Note'} balance reduced from ${fmt$(prevBalance)} to ${fmt$(curBalance)} — ` +
              `${fmt$(delta)} converted or repaid.`,
            );
            existing.lastBalance = curBalance;
          } else if (curBalance === 0 && (prevBalance ?? 0) > 0) {
            const lender = n.investorName ? ` (${n.investorName})` : '';
            events.push(`→ [NOTE RETIRED] ${lender ? lender.slice(2, -1) : 'Note'} fully retired or converted.`);
            existing.lastBalance = 0;
          }
        }
        // Enrich investor name if we now have it
        if (!existing.investorName && n.investorName) existing.investorName = n.investorName;
      }
    }

    // ── Equity facilities (state-aware) ──────────────────────────────────
    for (const f of r.equityFacilities.filter(f => f._section !== 'subsequent_events')) {
      const existing = findSeenFacility(f);
      const typeStr  = FACILITY_TYPE_LABEL[f.facilityType ?? 'other'];
      const name     = f.counterpartyName ?? typeStr;

      if (!existing) {
        seenFacilities.push({
          counterpartyName: f.counterpartyName,
          facilitySize:     f.facilitySize,
          drawnAmount:      f.drawnAmount,
          facilityType:     f.facilityType,
        });
        const sizeStr  = f.facilitySize ? ` (${fmt$(f.facilitySize)} commitment)` : '';
        const partyStr = f.counterpartyName ? ` with ${f.counterpartyName}` : '';
        const drawnStr = f.drawnAmount && f.drawnAmount > 0 ? `; ${fmt$(f.drawnAmount)} drawn` : '';
        events.push(`→ [NEW FACILITY] ${typeStr}${sizeStr}${partyStr}${drawnStr}.`);
      } else {
        // Check for size change (expanded/amended)
        if (f.facilitySize && existing.facilitySize) {
          const sizeDelta = f.facilitySize - existing.facilitySize;
          const sizePct   = sizeDelta / existing.facilitySize;
          if (Math.abs(sizePct) >= 0.05) {
            const state = sizeDelta > 0 ? 'EXPANDED' : 'REDUCED';
            events.push(
              `→ [FACILITY ${state}] ${name} — commitment changed from ${fmt$(existing.facilitySize)} to ${fmt$(f.facilitySize)}.`,
            );
            existing.facilitySize = f.facilitySize;
          }
        }
        // Check for draw changes
        const prevDraw = existing.drawnAmount ?? 0;
        const curDraw  = f.drawnAmount ?? 0;
        const drawDelta = curDraw - prevDraw;
        if (drawDelta >= 5_000) {
          events.push(
            `→ [FACILITY DRAW] ${name} — ${fmt$(drawDelta)} drawn; cumulative ${fmt$(curDraw)}${f.facilitySize ? ` of ${fmt$(f.facilitySize)}` : ''}.`,
          );
          existing.drawnAmount = curDraw;
        }
      }
    }

    // Check for terminated facilities (present last period, absent now)
    if (qualifying.indexOf(filing) > 0) {
      const prevFiling = qualifying[qualifying.indexOf(filing) - 1];
      const prevFacilities = prevFiling.financingReport?.equityFacilities ?? [];
      for (const pf of prevFacilities.filter(f => f._section !== 'subsequent_events')) {
        const stillPresent = r.equityFacilities.some(f => {
          const nameMatch = pf.counterpartyName && f.counterpartyName &&
            pf.counterpartyName.toLowerCase() === f.counterpartyName.toLowerCase();
          const sizeMatch = pf.facilitySize && f.facilitySize &&
            Math.abs(pf.facilitySize - f.facilitySize) / pf.facilitySize < 0.05;
          return nameMatch || sizeMatch;
        });
        if (!stillPresent && findSeenFacility(pf)) {
          const typeStr  = FACILITY_TYPE_LABEL[pf.facilityType ?? 'other'];
          const name     = pf.counterpartyName ?? typeStr;
          events.push(`→ [FACILITY TERMINATED?] ${name} no longer disclosed — may have expired or been terminated.`);
        }
      }
    }

    // ── Equity issuances (period-specific) ───────────────────────────────
    const commonIss = r.equityIssuances.filter(e => e.issuanceType !== 'preferred');
    if (commonIss.length > 0) {
      const totalShares   = commonIss.reduce((s, e) => s + (e.sharesIssued   ?? 0), 0);
      const totalProceeds = commonIss.reduce((s, e) => s + (e.grossProceeds ?? 0), 0);
      const shrStr  = totalShares   > 0 ? fmtShares(totalShares) : `${commonIss.length} transaction${commonIss.length > 1 ? 's' : ''}`;
      const procStr = totalProceeds > 0 ? ` — ${fmt$(totalProceeds)} gross proceeds` : '';
      events.push(`→ [COMMON ISSUANCE] ${shrStr}${procStr}.`);
    }
    const prefIss = r.equityIssuances.filter(e => e.issuanceType === 'preferred');
    if (prefIss.length > 0) {
      const proc = prefIss.reduce((s, e) => s + (e.grossProceeds ?? 0), 0);
      events.push(`→ [PREFERRED ISSUANCE]${proc > 0 ? ` ${fmt$(proc)} proceeds` : ''}.`);
    }

    // ── Debt conversions (period-specific) ───────────────────────────────
    const periodConv = r.conversions.filter(c => c._section !== 'subsequent_events');
    if (periodConv.length > 0) {
      const totalDebt   = periodConv.reduce((s, c) => s + (c.debtConverted ?? 0), 0);
      const totalShares = periodConv.reduce((s, c) => s + (c.sharesIssued  ?? 0), 0);
      const pxStr       = totalDebt > 0 && totalShares > 0
        ? ` @ $${(totalDebt / totalShares).toFixed(5)}/share`
        : '';
      const debtStr     = totalDebt   > 0 ? `${fmt$(totalDebt)} principal` : '';
      const sharesStr   = totalShares > 0 ? ` → ${fmtShares(totalShares)}` : '';
      events.push(`→ [CONVERSION] ${debtStr}${sharesStr}${pxStr}.`);
    }

    // ── Warrants (period-specific) ────────────────────────────────────────
    const pWarrants = r.warrants.filter(w => w._section !== 'subsequent_events' && (w.warrantShares ?? 0) > 0);
    if (pWarrants.length > 0) {
      const totalWS = pWarrants.reduce((s, w) => s + (w.warrantShares ?? 0), 0);
      events.push(`→ [WARRANTS] ${fmtShares(totalWS)} disclosed.`);
    }

    if (events.length === 0) continue;
    blocks.push(`${periodLabel(filing)}\n${events.join('\n')}`);
  }

  if (blocks.length === 0) return '';

  const intro =
    'The following timeline reconstructs financing events chronologically across all analyzed filings. ' +
    'Instrument states are tracked — a [NEW NOTE] appears only on first disclosure; ' +
    'subsequent periods reflect balance changes, conversions, or retirements. ' +
    'Facility states (NEW / EXPANDED / DRAW / TERMINATED) are tracked across periods.';

  return `14. FINANCING TIMELINE\n\n${intro}\n\n${blocks.join('\n\n')}`;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * For every 10-K / 10-Q in `normalized` that has a financingReport, finds
 * the prior filing of the same base type and injects a comparison section
 * into the filing's reportText.
 *
 * Mutates `normalized` in place. Non-fatal — individual comparison failures
 * are silently skipped so they never block the pipeline.
 */
export function enrichWithComparisons(normalized: NormalizedFiling[]): void {
  // Process filings oldest-first so earlier periods are already available
  // when later ones look for a prior filing.
  const relevant = [...normalized]
    .filter(f => ['10-K', '10-K/A', '10-Q', '10-Q/A'].includes(f.formType) && f.financingReport)
    .sort((a, b) => a.filedAt.localeCompare(b.filedAt));

  for (const filing of relevant) {
    try {
      const prior = findPriorFiling(normalized, filing);
      if (!prior) continue;

      const comparisonBody = compareFilings(filing, prior);
      if (!filing.financingReport) continue;

      filing.financingReport.reportText = injectComparisonSection(
        filing.financingReport.reportText,
        comparisonBody,
      );
    } catch {
      // Non-fatal — skip this filing's comparison
    }
  }

  // Inject Financing Timeline into the most recent qualifying filing.
  // The timeline spans all filings so it belongs in the most current report.
  try {
    const timelineText = buildFinancingTimeline(normalized);
    if (timelineText) {
      const mostRecent = [...relevant].sort((a, b) => b.filedAt.localeCompare(a.filedAt))[0];
      if (mostRecent?.financingReport) {
        mostRecent.financingReport.reportText += SECTION_DIVIDER + timelineText;
      }
    }
  } catch {
    // Non-fatal
  }
}
