export default function Footer({ disclaimer }: { disclaimer?: string }) {
  return (
    <div className="page-footer">
      <div className="footer-logo">OTC<span>Intel</span></div>
      <div className="footer-disclaimer">
        {disclaimer ?? 'All data sourced from publicly available SEC filings and OTC Markets disclosures. Risk scores and dilution estimates are analytical outputs based on public data. Provided for informational purposes only. Not investment advice. OTCIntel does not use non-public information.'}
      </div>
    </div>
  );
}
