/**
 * OTCIntel — Filesystem repository implementations
 *
 * Wraps the synchronous lib/db/index.ts interface in the async IRepositories
 * contract. All methods immediately resolve — no I/O latency beyond disk read.
 *
 * This module is used when PERSISTENCE_BACKEND=filesystem (the default).
 * It delegates to lib/db/index.ts so no behavior is duplicated.
 */

import type {
  ICompaniesRepository,
  IFilingsRepository,
  IRunsRepository,
  IIntelligenceRepository,
  IFinancialSnapshotsRepository,
} from './types';
import { companiesDb, filingsDb, runsDb, intelligenceDb, snapshotsDb } from './index';

export const filesystemCompaniesRepo: ICompaniesRepository = {
  async getAll()                           { return companiesDb.getAll(); },
  async getByCik(cik)                      { return companiesDb.getByCik(cik); },
  async getByTicker(ticker)                { return companiesDb.getByTicker(ticker); },
  async upsert(company)                    { return companiesDb.upsert(company); },
  async upsertAll(companies)               { return companiesDb.upsertAll(companies); },
  async updateStatus(cik, updates)         { return companiesDb.updateStatus(cik, updates); },
  async count()                            { return companiesDb.count(); },
};

export const filesystemFilingsRepo: IFilingsRepository = {
  async getByTicker(ticker)                { return filingsDb.getByTicker(ticker); },
  async hasAccession(ticker, acc)          { return filingsDb.hasAccession(ticker, acc); },
  async knownAccessions(ticker)            { return filingsDb.knownAccessions(ticker); },
  async upsertAll(ticker, incoming)        { return filingsDb.upsertAll(ticker, incoming); },
  async getAllTickers()                     { return filingsDb.getAllTickers(); },
  async totalCount()                       { return filingsDb.totalCount(); },
};

export const filesystemRunsRepo: IRunsRepository = {
  async getAll()                           { return runsDb.getAll(); },
  async getById(runId)                     { return runsDb.getById(runId); },
  async upsert(run)                        { return runsDb.upsert(run); },
  async getResults(runId)                  { return runsDb.getResults(runId); },
  async upsertResult(result)               { return runsDb.upsertResult(result); },
};

export const filesystemIntelligenceRepo: IIntelligenceRepository = {
  async getByTicker(ticker)                { return intelligenceDb.getByTicker(ticker); },
  async upsert(intelligence)               { return intelligenceDb.upsert(intelligence); },
  async getAllTickers()                     { return intelligenceDb.getAllTickers(); },
};

export const filesystemFinancialSnapshotsRepo: IFinancialSnapshotsRepository = {
  async getLatestByCompany(ticker)         { return snapshotsDb.getLatestByCompany(ticker); },
  async getByCompany(ticker)               { return snapshotsDb.getByCompany(ticker); },
  async getByAccession(accessionNumber)    { return snapshotsDb.getByAccession(accessionNumber); },
  async upsert(snapshot)                   { return snapshotsDb.upsert(snapshot); },
};
