import Link from 'next/link';

export const metadata = { title: 'OTCIntel — OTC Market Intelligence' };

export default function LandingPage() {
  return (
    <>
      {/* Fixed nav */}
      <nav className="landing-nav">
        <Link href="/" className="nav-logo">OTC<span>Intel</span></Link>
        <div className="landing-nav-links">
          <a href="#problem">The gap</a>
          <a href="#platform">Platform</a>
          <Link href="/companies">Example</Link>
          <a href="#for">Who it&apos;s for</a>
          <a href="#access" className="nav-cta">Request access</a>
        </div>
      </nav>

      {/* HERO */}
      <div className="hero">
        <div className="hero-grid" />
        <div className="hero-glow" />
        <p className="hero-eyebrow">OTC Market Intelligence</p>
        <h1 className="hero-headline">
          Decode the financing<br /><em>behind the stock.</em>
        </h1>
        <p className="hero-sub">
          OTCIntel analyzes OTC and microcap financing structures — convertible notes, equity lines, warrants, and preferred stock — and turns complex SEC filings into structured, readable intelligence.
        </p>
        <div className="hero-actions">
          <a href="#access" className="btn-primary">Request early access</a>
          <Link href="/company/AITX" className="btn-ghost">See an example →</Link>
        </div>
        <div className="hero-ticker">
          <div className="ticker-track">
            <span className="ticker-item">ABCD &nbsp;<span className="risk-high">RISK 83</span>&nbsp; $2M convertible · 20% discount · 10-day lookback</span>
            <span className="ticker-item">WXYZ &nbsp;<span className="risk-high">RISK 87</span>&nbsp; Convertible note · $1.5M · 22% discount to VWAP</span>
            <span className="ticker-item">EFGH &nbsp;<span className="risk-med">RISK 42</span>&nbsp; Convertible note · 12% discount · floor price $0.18</span>
            <span className="ticker-item">MNOP &nbsp;<span className="risk-high">RISK 91</span>&nbsp; Convertible note · 25% discount · reset provisions</span>
            <span className="ticker-item">QRST &nbsp;<span className="risk-med">RISK 55</span>&nbsp; Equity line · $1.5M facility · variable pricing</span>
            <span className="ticker-item">UVWX &nbsp;<span className="risk-low">RISK 14</span>&nbsp; No active convertibles · clean balance sheet</span>
            <span className="ticker-item">ABCD &nbsp;<span className="risk-high">RISK 83</span>&nbsp; $2M convertible · 20% discount · 10-day lookback</span>
            <span className="ticker-item">WXYZ &nbsp;<span className="risk-high">RISK 87</span>&nbsp; Convertible note · $1.5M · 22% discount to VWAP</span>
            <span className="ticker-item">EFGH &nbsp;<span className="risk-med">RISK 42</span>&nbsp; Convertible note · 12% discount · floor price $0.18</span>
            <span className="ticker-item">MNOP &nbsp;<span className="risk-high">RISK 91</span>&nbsp; Convertible note · 25% discount · reset provisions</span>
            <span className="ticker-item">QRST &nbsp;<span className="risk-med">RISK 55</span>&nbsp; Equity line · $1.5M facility · variable pricing</span>
            <span className="ticker-item">UVWX &nbsp;<span className="risk-low">RISK 14</span>&nbsp; No active convertibles · clean balance sheet</span>
          </div>
        </div>
      </div>

      {/* PROBLEM */}
      <div className="problem-section" id="problem">
        <div>
          <p className="section-label">The gap</p>
          <h2 className="section-headline">OTC financing is complex. The tools to analyze it are not.</h2>
          <p className="section-sub">OTC microcap companies regularly enter convertible notes, equity lines, and warrant agreements with terms that directly affect share structure. Most market participants have no structured analytical framework for assessing this risk — they rely on manual filing reads, community forums, and fragmented data sources.</p>
          <p className="section-sub" style={{ marginTop: '1rem' }}>OTCIntel is built to address that gap. We extract, structure, and score the financing mechanics embedded in public SEC filings so that the analysis is systematic rather than ad hoc.</p>
        </div>
        <div>
          <p className="section-label" style={{ marginBottom: '1.25rem' }}>What currently doesn&apos;t exist</p>
          <div className="gap-list">
            <div className="gap-item">
              <span className="gap-num">01</span>
              <div className="gap-text"><strong>No structured financing database</strong>There is no publicly accessible, searchable database of OTC convertible note terms, discount rates, lookback windows, and warrant coverage built from SEC filings.</div>
            </div>
            <div className="gap-item">
              <span className="gap-num">02</span>
              <div className="gap-text"><strong>No standardized risk scoring</strong>Existing OTC tools surface price and volume data. None apply a consistent analytical model to financing structure complexity or dilution risk across companies.</div>
            </div>
            <div className="gap-item">
              <span className="gap-num">03</span>
              <div className="gap-text"><strong>No automated filing extraction</strong>Converting SEC filings into structured financing data currently requires manual review of legal documents — a process that is time-consuming and inconsistent.</div>
            </div>
            <div className="gap-item">
              <span className="gap-num">04</span>
              <div className="gap-text"><strong>No investor pattern tracking</strong>Repeat financing participants across multiple OTC companies are not systematically tracked or made searchable anywhere in the market today.</div>
            </div>
          </div>
        </div>
      </div>

      {/* MODULES */}
      <section className="modules-section" id="platform">
        <p className="section-label">The platform</p>
        <h2 className="section-headline">Six modules. One complete picture of OTC financing risk.</h2>
        <p className="section-sub">Each module targets a specific layer of OTC capital structure analysis — from raw filing extraction to portfolio-level monitoring.</p>
        <div className="modules-grid">
          {[
            { num: '01', name: 'Risk Score', desc: 'A 0–100 scoring model that quantifies financing risk across discount depth, lookback windows, warrant coverage, reset provisions, and floor price mechanics. Comparable across companies and over time.' },
            { num: '02', name: 'Dilution Model', desc: 'Model shares issued and dilution percentage across financing scenarios. Adjust price, discount, tranche size, and warrant exercises to understand how share structure changes under different conditions.' },
            { num: '03', name: 'Filing Summaries', desc: 'SEC filings translated into structured data. Conversion terms, discount rates, lookback periods, and financing size extracted from 8-Ks, S-1s, and NT filings and presented in a consistent, readable format.' },
            { num: '04', name: 'Financing Database', desc: 'A searchable database of OTC financing deals built from public filings. Filter by discount rate, financing type, investor, deal size, and date. Identify patterns across the market and track repeat participants.' },
            { num: '05', name: 'Share Structure Analytics', desc: 'Authorized shares, outstanding shares, float, and reserve requirements mapped against active convertibles, warrants, and equity facilities. A consolidated view of dilution exposure built from public disclosures.' },
            { num: '06', name: 'Financing Alerts', desc: 'Structured notifications when new financing events are filed for tracked companies. Subscribe by ticker, investor, risk threshold, or financing type. Alerts include a structured summary of key terms, not just a raw filing link.' },
          ].map(m => (
            <div className="module-cell" key={m.num}>
              <div className="module-tag">Module {m.num}</div>
              <div className="module-name">{m.name}</div>
              <div className="module-desc">{m.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* DEMO */}
      <div className="demo-section" id="demo">
        <p className="section-label">Example output</p>
        <div className="demo-wrap">
          <div>
            <h2 className="section-headline">What a company intelligence page looks like.</h2>
            <p className="section-sub">Every tracked company gets a structured intelligence page built from public SEC filings and OTC Markets disclosures. The example shown is illustrative — all data fields reflect the type of information extracted from publicly available sources.</p>
            <p className="section-sub" style={{ marginTop: '1rem' }}>The goal is to reduce the time required to understand a company&apos;s financing structure from hours of document review to a single, structured page.</p>
          </div>
          <div className="company-card">
            <div className="card-header">
              <div>
                <div className="card-ticker-demo">ABCD</div>
                <div className="card-name-demo">Alpha Bio Corp. &nbsp;·&nbsp; OTC Markets</div>
              </div>
              <div>
                <div className="card-price-val">$0.18</div>
                <div className="card-price-change-demo">▼ -12.3% today</div>
              </div>
            </div>
            <div className="card-body-demo">
              <div className="card-section-head">Share structure</div>
              <div className="card-row"><span className="card-row-label">Shares outstanding</span><span className="card-row-val">45,000,000</span></div>
              <div className="card-row"><span className="card-row-label">Authorized shares</span><span className="card-row-val">500,000,000</span></div>
              <div className="card-row"><span className="card-row-label">Float</span><span className="card-row-val">38,200,000</span></div>
              <div className="card-section-head">Active financing</div>
              <div className="card-row"><span className="card-row-label">Convertible note</span><span className="card-row-val">$2,000,000</span></div>
              <div className="card-row"><span className="card-row-label">Discount to market</span><span className="card-row-val" style={{ color: '#E24B4A' }}>20%</span></div>
              <div className="card-row"><span className="card-row-label">Lookback window</span><span className="card-row-val">10-day VWAP</span></div>
              <div className="card-row"><span className="card-row-label">Warrants outstanding</span><span className="card-row-val">8,000,000</span></div>
              <div className="card-row"><span className="card-row-label">Est. shares at conversion</span><span className="card-row-val" style={{ color: '#E24B4A' }}>13,888,889</span></div>
              <div className="card-row"><span className="card-row-label">Est. dilution exposure</span><span className="card-row-val" style={{ color: '#E24B4A' }}>30.9%</span></div>
              <div className="risk-bar-wrap-demo">
                <div className="risk-bar-label-demo">
                  <span>OTCIntel risk score</span>
                  <span><span className="risk-badge high">83 — High risk</span></span>
                </div>
                <div className="risk-bar-track-demo"><div className="risk-bar-fill-demo" /></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* WHO IT'S FOR */}
      <section className="for-section" id="for">
        <p className="section-label">Who it&apos;s for</p>
        <h2 className="section-headline">Built for anyone who needs to understand OTC financing risk.</h2>
        <p className="section-sub">OTCIntel is designed for users who work with OTC and microcap markets and need more than price data to make informed decisions.</p>
        <div className="for-grid">
          {[
            { role: 'Primary user', title: 'OTC traders and active investors', desc: 'Traders who follow OTC and microcap companies and need to understand share structure, financing risk, and dilution mechanics before taking a position.', uses: ['Evaluate convertible note terms before trading', 'Model dilution scenarios across price levels', 'Monitor new financing events for watchlist companies', 'Identify high-risk financing structures quickly'] },
            { role: 'Analyst use case', title: 'Small-cap and microcap analysts', desc: 'Analysts covering OTC or early-stage public companies who need structured data on financing terms, capital stack mechanics, and share reserve math.', uses: ['Build consistent financing models across coverage', 'Track dilution exposure over multiple reporting periods', 'Research investor patterns across deals', 'Access structured filing data without manual extraction'] },
            { role: 'Research and media', title: 'Financial journalists and researchers', desc: 'Writers and researchers investigating OTC market practices, toxic financing patterns, or company-specific capital structure issues who need structured, sourced data.', uses: ['Identify financing patterns across multiple companies', 'Trace repeat financing participants and deal structures', 'Source data from public filings with clear attribution', 'Compare financing terms across industries or time periods'] },
            { role: 'Learning and education', title: 'Retail investors building expertise', desc: 'Individual investors who are learning how OTC financing structures work and want a clear, structured resource for understanding the mechanics behind share dilution and convertible financing.', uses: ['Understand convertible note mechanics with real examples', 'Use the dilution simulator to test financing scenarios', 'Learn to read share structure data systematically', 'Develop a framework for evaluating OTC financing risk'] },
          ].map(c => (
            <div className="for-card" key={c.role}>
              <div className="for-role">{c.role}</div>
              <div className="for-title">{c.title}</div>
              <div className="for-desc">{c.desc}</div>
              <ul className="for-uses">
                {c.uses.map(u => <li key={u}>{u}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <div className="cta-band" id="access">
        <p className="section-label">Early access</p>
        <h2 className="section-headline">OTCIntel is currently in private development.</h2>
        <p className="section-sub">We are building toward a public launch. If you work in OTC markets as a trader, analyst, journalist, or investor and are interested in early access, reach out directly.</p>
        <div className="cta-actions">
          <a href="mailto:alec@otcintel.com" className="btn-primary">Request early access</a>
          <a href="mailto:alec@otcintel.com" className="btn-ghost">Contact us →</a>
        </div>
      </div>

      <footer className="landing-footer">
        <div className="landing-footer-logo">OTC<span>Intel</span></div>
        <div className="landing-footer-note">
          OTCIntel is a financial analytics platform. All data is sourced exclusively from publicly available SEC filings, OTC Markets disclosures, and company press releases. Nothing on this platform constitutes investment advice. OTCIntel does not use or reference non-public information. All risk scores and analytical estimates are outputs based on public data and are provided for informational and research purposes only.
        </div>
      </footer>
    </>
  );
}
