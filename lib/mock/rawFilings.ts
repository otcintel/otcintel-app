/**
 * Mock raw filing data
 *
 * Simulates the response from SEC EDGAR (or a third-party filing provider).
 * Each record includes realistic filing text that the parsers can extract from.
 *
 * The text content is authored to match actual OTC financing disclosure language
 * and to exercise all parser patterns. In production, `text` is fetched from
 * the EDGAR archive via fetchFilingText().
 */

import type { RawFiling } from '../ingestion/types';

export const mockRawFilings: Record<string, RawFiling[]> = {

  WXYZ: [
    {
      accessionNumber: '0001876543-26-000001',
      ticker: 'WXYZ',
      cik: '0001876543',
      formType: '8-K',
      filedAt: '2026-03-18',
      periodOfReport: '2026-03-18',
      documentUrl: 'https://www.sec.gov/Archives/edgar/data/1876543/000187654326000001/8k.htm',
      fullTextUrl:  'https://www.sec.gov/Archives/edgar/data/1876543/000187654326000001/0001876543-26-000001.txt',
      items: '1.01,9.01',
      text: `
UNITED STATES SECURITIES AND EXCHANGE COMMISSION
Washington, D.C. 20549

FORM 8-K
CURRENT REPORT

Pursuant to Section 13 or 15(d) of the Securities Exchange Act of 1934

Date of Report: March 18, 2026
Westyx Industries Inc.
Commission File Number: 000-12345

Item 1.01. Entry into a Material Definitive Agreement.

On March 18, 2026, Westyx Industries Inc. (the "Company") entered into a Securities Purchase Agreement (the "SPA") with Northfield Capital Group LLC (the "Investor"), pursuant to which the Company issued and sold to the Investor a Convertible Promissory Note (the "Note") in the aggregate principal amount of $1,500,000.

The Note bears interest at 8% per annum and matures on February 12, 2027. The Note is convertible into shares of the Company's common stock at a conversion price equal to 78% of the lowest volume-weighted average price ("VWAP") of the Company's common stock during the 10 trading days immediately preceding the conversion date. The Note contains anti-dilution provisions, including reset provisions that adjust the conversion price downward if shares of common stock are subsequently issued at a price lower than the then-current conversion price. The Note does not contain a floor conversion price.

In connection with the SPA, the Company issued to the Investor warrants to purchase 12,000,000 shares of the Company's common stock at an exercise price of $0.10 per share. The warrants expire on February 12, 2028.

The issuance of shares upon conversion of the Note and exercise of the Warrants could significantly dilute the ownership interests of existing stockholders. Based on the current market price of $0.07 per share, the estimated conversion price is $0.0546 per share, which would result in the issuance of approximately 27,472,527 shares of common stock, representing dilution of approximately 26.1% on a fully diluted basis.

As of March 18, 2026, there were 112,000,000 shares of the Company's common stock issued and outstanding. The Company has 1,000,000,000 shares of common stock authorized.

Item 9.01. Financial Statements and Exhibits.

(d) Exhibits.
10.1 Securities Purchase Agreement, dated March 18, 2026.
10.2 Convertible Promissory Note, dated March 18, 2026.
10.3 Common Stock Purchase Warrant, dated March 18, 2026.
      `,
    },
    {
      accessionNumber: '0001876543-25-000088',
      ticker: 'WXYZ',
      cik: '0001876543',
      formType: '10-Q',
      filedAt: '2025-11-14',
      periodOfReport: '2025-09-30',
      documentUrl: 'https://www.sec.gov/Archives/edgar/data/1876543/000187654325000088/10q.htm',
      fullTextUrl:  'https://www.sec.gov/Archives/edgar/data/1876543/000187654325000088/0001876543-25-000088.txt',
      text: `
WESTYX INDUSTRIES INC.
Form 10-Q — Quarterly Report
For the quarterly period ended September 30, 2025

NOTE 6. STOCKHOLDERS' EQUITY

As of September 30, 2025, the Company was authorized to issue 1,000,000,000 shares of common stock, $0.001 par value per share, and 25,000,000 shares of preferred stock, $0.001 par value per share.

As of September 30, 2025, there were 108,000,000 shares of our common stock issued and outstanding, and 8,000,000 shares of Series A preferred stock issued and outstanding.

The Company's shares of common stock are traded on the OTC Pink marketplace under the symbol "WXYZ."
      `,
    },
  ],

  EFGH: [
    {
      accessionNumber: '0002134567-26-000042',
      ticker: 'EFGH',
      cik: '0002134567',
      formType: '8-K/A',
      filedAt: '2026-03-22',
      periodOfReport: '2026-03-22',
      documentUrl: 'https://www.sec.gov/Archives/edgar/data/2134567/000213456726000042/8ka.htm',
      fullTextUrl:  'https://www.sec.gov/Archives/edgar/data/2134567/000213456726000042/0002134567-26-000042.txt',
      items: '1.01',
      text: `
UNITED STATES SECURITIES AND EXCHANGE COMMISSION
Washington, D.C. 20549

FORM 8-K/A
CURRENT REPORT (AMENDMENT NO. 1)

Date of Report: March 22, 2026
EFG Holdings Group
Commission File Number: 000-54321

Item 1.01. Amendment to Material Definitive Agreement.

EFG Holdings Group (the "Company") is filing this Amendment No. 1 to its Current Report on Form 8-K to disclose an amendment (the "Amendment") to the terms of its existing Convertible Promissory Note (the "Note") with Silverton Funding Partners LLC (the "Holder").

The Amendment, effective March 22, 2026, modifies the following terms of the Note:

1. The remaining principal balance of the Note is $500,000.

2. The maturity date of the Note has been extended to November 30, 2026.

3. The conversion price under the Note remains at 88% of the lowest volume-weighted average price ("VWAP") of the Company's common stock during the 5 trading days immediately preceding the conversion date, subject to a floor conversion price of $0.18 per share. The conversion price shall not be less than $0.18 per share.

4. The Note does not contain anti-dilution reset provisions. No adjustment to the conversion price will occur based on subsequent issuances of shares at lower prices.

5. No new warrants were issued in connection with the Amendment. Warrants to purchase 3,000,000 shares of the Company's common stock at an exercise price of $0.35 per share remain outstanding from the original issuance in November 2024.

The amendment could result in dilution to existing stockholders; however, the floor conversion price of $0.18 limits the potential issuance to approximately 2,367,424 shares from the remaining note balance.

As of March 22, 2026, there were 55,000,000 shares of the Company's common stock issued and outstanding. The Company is authorized to issue 500,000,000 shares of common stock.

3,000,000 shares of Series B preferred stock are issued and outstanding.
      `,
    },
  ],

  ABCD: [
    {
      accessionNumber: '0001654321-26-000199',
      ticker: 'ABCD',
      cik: '0001654321',
      formType: '8-K',
      filedAt: '2026-04-03',
      periodOfReport: '2026-04-03',
      documentUrl: 'https://www.sec.gov/Archives/edgar/data/1654321/000165432126000199/8k.htm',
      fullTextUrl:  'https://www.sec.gov/Archives/edgar/data/1654321/000165432126000199/0001654321-26-000199.txt',
      items: '1.01,9.01',
      text: `
UNITED STATES SECURITIES AND EXCHANGE COMMISSION
Washington, D.C. 20549

FORM 8-K
CURRENT REPORT

Date of Report: April 3, 2026
Alpha Bio Corp.
Commission File Number: 000-99887

Item 1.01. Entry into a Material Definitive Agreement.

On April 3, 2026, Alpha Bio Corp. (the "Company") entered into a Note Purchase Agreement (the "Agreement") with Westbridge Capital LLC (the "Purchaser"), pursuant to which the Company issued and sold to the Purchaser a Senior Convertible Note (the "Note") in the principal amount of $2,000,000.

The Note matures on March 15, 2027 and bears interest at 6% per annum. The Note is convertible into shares of the Company's common stock at a conversion price equal to 80% of the lowest volume-weighted average price ("VWAP") of the common stock during the 10 trading days immediately prior to the conversion date. The Note includes anti-dilution and reset provisions that may reduce the conversion price if shares are subsequently issued at prices lower than the then-current conversion price. There is no floor conversion price under the Note.

The Company also issued to the Purchaser warrants to purchase 8,000,000 shares of the Company's common stock at an exercise price of $0.22 per share. The warrants expire on March 15, 2028.

The conversion of the Note and exercise of the Warrants would result in significant dilution to existing stockholders. At the current market price of $0.18 per share, the estimated conversion price is $0.1440 per share, which would result in the issuance of approximately 13,888,889 additional shares of common stock from conversion plus 8,000,000 shares from warrant exercises, representing dilution of approximately 30.9% on a fully diluted basis.

As of April 3, 2026, there were 45,000,000 shares of our common stock issued and outstanding. The Company has 500,000,000 shares of common stock authorized.

Item 9.01. Financial Statements and Exhibits.

(d) Exhibits.
10.1 Note Purchase Agreement, dated April 3, 2026.
10.2 Senior Convertible Note, dated April 3, 2026.
10.3 Common Stock Purchase Warrant, dated April 3, 2026.
      `,
    },
    {
      accessionNumber: '0001654321-26-000055',
      ticker: 'ABCD',
      cik: '0001654321',
      formType: '10-Q',
      filedAt: '2026-02-14',
      periodOfReport: '2025-12-31',
      documentUrl: 'https://www.sec.gov/Archives/edgar/data/1654321/000165432126000055/10q.htm',
      fullTextUrl:  'https://www.sec.gov/Archives/edgar/data/1654321/000165432126000055/0001654321-26-000055.txt',
      text: `
ALPHA BIO CORP.
Form 10-Q — Quarterly Report
For the quarterly period ended December 31, 2025

NOTE 8. CAPITAL STOCK

As of December 31, 2025, the Company was authorized to issue 500,000,000 shares of common stock, $0.0001 par value per share.

As of December 31, 2025, there were 44,500,000 shares of our common stock issued and outstanding, and 5,000,000 shares of Series A preferred stock were issued and outstanding.

NOTE 9. SUBSEQUENT EVENTS

On April 3, 2026, the Company entered into a Note Purchase Agreement with Westbridge Capital LLC. See Note 1.01 in the Company's Current Report on Form 8-K filed April 3, 2026.
      `,
    },
  ],

};
