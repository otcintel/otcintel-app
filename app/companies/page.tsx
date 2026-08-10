import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { getCompanies } from '@/lib/server-data';
import CompaniesClient from './CompaniesClient';

export const metadata = { title: 'Companies — OTCIntel' };

export default async function CompaniesPage() {
  const companies = await getCompanies();

  return (
    <>
      <Nav />
      <div className="page-wide">
        <CompaniesClient companies={companies} />
        <Footer disclaimer="All data sourced from publicly available SEC EDGAR filings. Confidence scores reflect extraction quality, not investment suitability. Nothing on this page constitutes investment advice." />
      </div>
    </>
  );
}
