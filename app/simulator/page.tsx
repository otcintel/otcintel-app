'use client';

import { useState, useCallback } from 'react';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

interface SimResult {
  convPrice: number;
  floorApplied: boolean;
  floorVal: number;
  newShares: number;
  totalFromNote: number;
  totalShares: number;
  dilutionPct: number;
  amount: number;
  price: number;
  discount: number;
  sharesOut: number;
  warrantShares: number;
  lookback: number;
}

interface ScenarioRow {
  label: string;
  sPrice: number;
  sConv: number;
  sNew: number;
  sDil: number;
  isCurrent: boolean;
}

const DEFAULTS = {
  amount: '1000000',
  price: '0.20',
  discount: '15',
  sharesOut: '50000000',
  warrants: '',
  floor: '',
  lookback: '',
};

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function fmtShares(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function riskColor(pct: number): string {
  if (pct >= 30) return 'var(--red)';
  if (pct >= 15) return 'var(--amber)';
  return 'var(--green)';
}

function riskClass(pct: number): string {
  if (pct >= 30) return 'danger';
  if (pct >= 15) return 'warning';
  return 'positive';
}

function riskLabel(pct: number): string {
  if (pct >= 30) return 'High dilution risk.';
  if (pct >= 15) return 'Moderate dilution risk.';
  return 'Low dilution risk.';
}

export default function SimulatorPage() {
  const [fields, setFields] = useState(DEFAULTS);
  const [result, setResult] = useState<SimResult | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioRow[]>([]);
  const [error, setError] = useState('');

  const set = (key: keyof typeof DEFAULTS) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFields(prev => ({ ...prev, [key]: e.target.value }));
  };

  const runSimulation = useCallback(() => {
    const amount = parseFloat(fields.amount) || 0;
    const price = parseFloat(fields.price) || 0;
    const discount = parseFloat(fields.discount) || 0;
    const sharesOut = parseFloat(fields.sharesOut) || 0;
    const warrantShares = parseFloat(fields.warrants) || 0;
    const floorInput = parseFloat(fields.floor) || 0;
    const lookback = parseInt(fields.lookback) || 0;

    if (!amount || !price || !sharesOut) {
      setError('Please enter Financing Amount, Share Price, and Shares Outstanding.');
      return;
    }
    setError('');

    let convPrice = price * (1 - discount / 100);
    let floorApplied = false;
    if (floorInput > 0 && convPrice < floorInput) {
      convPrice = floorInput;
      floorApplied = true;
    }

    const newShares = amount / convPrice;
    const totalFromNote = newShares + warrantShares;
    const totalShares = sharesOut + totalFromNote;
    const dilPct = (totalFromNote / totalShares) * 100;

    setResult({
      convPrice,
      floorApplied,
      floorVal: floorInput,
      newShares,
      totalFromNote,
      totalShares,
      dilutionPct: dilPct,
      amount,
      price,
      discount,
      sharesOut,
      warrantShares,
      lookback,
    });

    const scenarioMultipliers = [
      { label: 'Price +50%', mult: 1.50, isCurrent: false },
      { label: 'Price +25%', mult: 1.25, isCurrent: false },
      { label: 'Current price', mult: 1.00, isCurrent: true },
      { label: 'Price -25%', mult: 0.75, isCurrent: false },
      { label: 'Price -50%', mult: 0.50, isCurrent: false },
    ];

    const rows: ScenarioRow[] = scenarioMultipliers.map(s => {
      const sPrice = price * s.mult;
      let sConv = sPrice * (1 - discount / 100);
      if (floorInput > 0 && sConv < floorInput) sConv = floorInput;
      const sNew = amount / sConv + warrantShares;
      const sTotal = sharesOut + sNew;
      const sDil = (sNew / sTotal) * 100;
      return { label: s.label, sPrice, sConv, sNew, sDil, isCurrent: s.isCurrent };
    });
    setScenarios(rows);
  }, [fields]);

  const resetSimulation = () => {
    setFields(DEFAULTS);
    setResult(null);
    setScenarios([]);
    setError('');
  };

  return (
    <>
      <Nav />
      <div className="page-wide">

        {/* PAGE HEADER */}
        <div className="page-header" style={{ display: 'block', borderBottom: '1px solid var(--rule)', paddingBottom: '1.75rem', marginBottom: '2.5rem' }}>
          <div className="page-eyebrow">OTCIntel Tools</div>
          <h1 className="page-title">Dilution Simulator</h1>
          <p className="page-subtitle">
            Estimate share issuance and dilution exposure from convertible notes and variable-rate financing structures. Inputs are user-defined; results are analytical estimates based on the terms provided.
          </p>
        </div>

        {/* SIMULATOR LAYOUT */}
        <div className="sim-layout">

          {/* LEFT: INPUTS */}
          <div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">Financing inputs</span>
              </div>
              <div className="card-body">

                <div className="field-section-label">Core terms</div>

                <div className="field-group">
                  <label className="field-label" htmlFor="financing-amount">Financing amount</label>
                  <div className="input-wrap">
                    <span className="input-prefix">$</span>
                    <input
                      type="number"
                      id="financing-amount"
                      className="has-prefix"
                      placeholder="1,000,000"
                      min={0}
                      step={50000}
                      value={fields.amount}
                      onChange={set('amount')}
                    />
                  </div>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="share-price">Current share price</label>
                  <div className="input-wrap">
                    <span className="input-prefix">$</span>
                    <input
                      type="number"
                      id="share-price"
                      className="has-prefix"
                      placeholder="0.20"
                      min={0}
                      step={0.01}
                      value={fields.price}
                      onChange={set('price')}
                    />
                  </div>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="discount">Conversion discount</label>
                  <div className="input-wrap">
                    <input
                      type="number"
                      id="discount"
                      className="has-suffix"
                      placeholder="15"
                      min={0}
                      max={99}
                      step={1}
                      value={fields.discount}
                      onChange={set('discount')}
                    />
                    <span className="input-suffix">%</span>
                  </div>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="shares-outstanding">Shares outstanding</label>
                  <div className="input-wrap">
                    <input
                      type="number"
                      id="shares-outstanding"
                      placeholder="50,000,000"
                      min={0}
                      step={1000000}
                      value={fields.sharesOut}
                      onChange={set('sharesOut')}
                    />
                  </div>
                  <div className="field-hint">Current shares outstanding per latest public filing.</div>
                </div>

                <hr className="field-divider" />
                <div className="field-section-label">
                  Optional terms
                  <span className="field-section-optional">Optional</span>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="warrant-shares">Warrant shares</label>
                  <div className="input-wrap">
                    <input
                      type="number"
                      id="warrant-shares"
                      placeholder="0"
                      min={0}
                      step={500000}
                      value={fields.warrants}
                      onChange={set('warrants')}
                    />
                  </div>
                  <div className="field-hint">Additional shares issuable from warrants connected to this financing.</div>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="floor-price">Floor price</label>
                  <div className="input-wrap">
                    <span className="input-prefix">$</span>
                    <input
                      type="number"
                      id="floor-price"
                      className="has-prefix"
                      placeholder="None"
                      min={0}
                      step={0.001}
                      value={fields.floor}
                      onChange={set('floor')}
                    />
                  </div>
                  <div className="field-hint">Minimum conversion price, if stated. Leave blank if no floor.</div>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="lookback">Lookback window</label>
                  <div className="input-wrap">
                    <input
                      type="number"
                      id="lookback"
                      className="has-suffix"
                      placeholder="10"
                      min={1}
                      max={90}
                      step={1}
                      value={fields.lookback}
                      onChange={set('lookback')}
                    />
                    <span className="input-suffix">days</span>
                  </div>
                  <div className="field-hint">VWAP lookback period used to calculate conversion price.</div>
                </div>

                {error && (
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--red)', marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: 'var(--red-dim)', border: '1px solid var(--red-border)', borderRadius: '3px' }}>
                    {error}
                  </div>
                )}

                <button className="run-btn" onClick={runSimulation}>
                  Run simulation
                </button>
                <button className="reset-btn" onClick={resetSimulation}>
                  Reset inputs
                </button>

              </div>
            </div>
          </div>

          {/* RIGHT: RESULTS */}
          <div className="results-col">

            {/* OUTPUT CARD */}
            <div className="card">
              <div className="card-head">
                <span className="card-title">Simulation output</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', letterSpacing: '0.08em', color: result ? 'var(--accent)' : 'var(--text-muted)', textTransform: 'uppercase' }}>
                  {result ? 'Results ready' : 'Awaiting inputs'}
                </span>
              </div>

              {!result ? (
                <div className="output-empty">
                  <div className="output-empty-icon">
                    <svg viewBox="0 0 24 24">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                  </div>
                  <div className="output-empty-title">No simulation run</div>
                  <div className="output-empty-sub">
                    Enter financing terms on the left and click<br />Run Simulation to see results.
                  </div>
                </div>
              ) : (
                <>
                  <div className="primary-metrics">
                    <div className="primary-metric">
                      <div className="pm-label">Conversion price</div>
                      <div className={`pm-val ${result.floorApplied ? 'warning' : 'neutral'}`}>
                        {fmtMoney(result.convPrice)}
                      </div>
                      <div className="pm-sub">
                        {result.floorApplied ? 'Floor price applied' : 'Per share'}
                      </div>
                    </div>
                    <div className="primary-metric">
                      <div className="pm-label">New shares issued</div>
                      <div className="pm-val danger">{fmtShares(result.newShares)}</div>
                      <div className="pm-sub">From note conversion</div>
                    </div>
                    <div className="primary-metric">
                      <div className="pm-label">Total shares (post)</div>
                      <div className="pm-val neutral">{fmtShares(result.totalShares)}</div>
                      <div className="pm-sub">Fully diluted</div>
                    </div>
                    <div className="primary-metric">
                      <div className="pm-label">Dilution exposure</div>
                      <div className={`pm-val ${riskClass(result.dilutionPct)}`}>
                        {result.dilutionPct.toFixed(1)}%
                      </div>
                      <div className="pm-sub">New shares / total shares</div>
                    </div>
                  </div>

                  <div className="card-body" style={{ paddingTop: '1.25rem' }}>
                    <div className="detail-row">
                      <span className="detail-label">Financing amount</span>
                      <span className="detail-val">${result.amount.toLocaleString('en-US')}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Share price (input)</span>
                      <span className="detail-val">{fmtMoney(result.price)}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Conversion discount</span>
                      <span className="detail-val">{result.discount.toFixed(1)}%</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Shares outstanding (pre)</span>
                      <span className="detail-val">{fmtShares(result.sharesOut)}</span>
                    </div>
                    {result.warrantShares > 0 && (
                      <div className="detail-row">
                        <span className="detail-label">Warrant shares</span>
                        <span className="detail-val danger">{fmtShares(result.warrantShares)}</span>
                      </div>
                    )}
                    {result.floorApplied && (
                      <div className="detail-row">
                        <span className="detail-label">Floor price applied</span>
                        <span className="detail-val warning">{fmtMoney(result.floorVal)}</span>
                      </div>
                    )}
                    {result.lookback > 0 && (
                      <div className="detail-row">
                        <span className="detail-label">Lookback window</span>
                        <span className="detail-val">{result.lookback}-day VWAP</span>
                      </div>
                    )}
                  </div>

                  <div className="dilution-bar-wrap">
                    <div className="dilution-bar-header">
                      <span className="dilution-bar-label">Dilution exposure</span>
                      <span className="dilution-bar-pct" style={{ color: riskColor(result.dilutionPct) }}>
                        {result.dilutionPct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="dilution-track">
                      <div
                        className="dilution-fill"
                        style={{ width: `${Math.min(result.dilutionPct, 100)}%`, background: riskColor(result.dilutionPct) }}
                      />
                    </div>
                    <div className="dilution-bar-sub">
                      {riskLabel(result.dilutionPct)} New shares as a percentage of fully diluted share count.
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* PRICE SCENARIOS CARD */}
            {scenarios.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Price scenarios</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
                    Dilution at different price levels
                  </span>
                </div>
                <table className="scenario-table">
                  <thead>
                    <tr>
                      <th>Scenario</th>
                      <th className="right">Share price</th>
                      <th className="right">Conv. price</th>
                      <th className="right">New shares</th>
                      <th className="right">Dilution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenarios.map((s, i) => (
                      <tr key={i} className={s.isCurrent ? 'current-row' : ''}>
                        <td className="label">{s.label}</td>
                        <td className="right">{fmtMoney(s.sPrice)}</td>
                        <td className="right">{fmtMoney(s.sConv)}</td>
                        <td className="right" style={{ color: riskColor(s.sDil) }}>{fmt(s.sNew)}</td>
                        <td className="right" style={{ color: riskColor(s.sDil), fontWeight: 500 }}>{s.sDil.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="sim-disclaimer">
                  Estimates assume full conversion at the stated discount. Warrant shares, if entered, are additive to total potential issuance. Actual dilution will vary based on conversion timing and terms not captured here. Not investment advice.
                </div>
              </div>
            )}

          </div>
        </div>

        <Footer disclaimer="All calculations are estimates based on user-provided inputs. Results are provided for informational purposes only and do not constitute investment advice." />
      </div>
    </>
  );
}
