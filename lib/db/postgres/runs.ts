/**
 * OTCIntel — PostgreSQL runs repository
 *
 * Implements IRunsRepository against `ingestion_runs` + `ingestion_run_results`.
 */

import type { IngestionRun, RunResult, IngestionRunStatus, RunResultStatus } from '../../universe/types';
import type { IRunsRepository } from '../types';
import { getClient, assertNoError } from './client';

// ─── Row types ────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  run_id: string;
  started_at: string;
  ended_at: string | null;
  parser_version: string;
  status: string;
  companies_attempted: number;
  companies_completed: number;
  companies_partial: number;
  companies_failed: number;
  filings_discovered: number;
  filings_downloaded: number;
  filings_parsed: number;
  warnings_count: number;
  errors: string[];
  created_at: string;
}

interface RunResultRow {
  id: string;
  run_id: string;
  cik: string;
  ticker: string;
  status: string;
  failed_stage: string | null;
  filings_discovered: number;
  filings_downloaded: number;
  filings_parsed: number;
  warnings_count: number;
  duration_ms: number | null;
  error_message: string | null;
  started_at: string;
  ended_at: string;
  created_at: string;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function rowToRun(row: RunRow): IngestionRun {
  return {
    runId:               row.run_id,
    startedAt:           row.started_at,
    endedAt:             row.ended_at ?? undefined,
    parserVersion:       row.parser_version,
    status:              row.status as IngestionRunStatus,
    companiesAttempted:  row.companies_attempted,
    companiesCompleted:  row.companies_completed,
    companiesPartial:    row.companies_partial,
    companiesFailed:     row.companies_failed,
    filingsDiscovered:   row.filings_discovered,
    filingsDownloaded:   row.filings_downloaded,
    filingsParsed:       row.filings_parsed,
    warningsCount:       row.warnings_count,
    errors:              row.errors ?? [],
  };
}

function rowToRunResult(row: RunResultRow): RunResult {
  return {
    runId:              row.run_id,
    cik:                row.cik,
    ticker:             row.ticker,
    status:             row.status as RunResultStatus,
    failedStage:        row.failed_stage as RunResult['failedStage'] ?? undefined,
    filingsDiscovered:  row.filings_discovered,
    filingsDownloaded:  row.filings_downloaded,
    filingsParsed:      row.filings_parsed,
    warningsCount:      row.warnings_count,
    durationMs:         row.duration_ms ?? 0,
    errorMessage:       row.error_message ?? undefined,
    startedAt:          row.started_at,
    endedAt:            row.ended_at,
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

export const postgresRunsDb: IRunsRepository = {
  async getAll(): Promise<IngestionRun[]> {
    const db = getClient();
    const { data, error } = await db
      .from('ingestion_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(100);
    assertNoError(error, 'runs.getAll');
    return (data as RunRow[]).map(rowToRun);
  },

  async getById(runId: string): Promise<IngestionRun | undefined> {
    const db = getClient();
    const { data, error } = await db
      .from('ingestion_runs')
      .select('*')
      .eq('run_id', runId)
      .maybeSingle();
    assertNoError(error, `runs.getById(${runId})`);
    return data ? rowToRun(data as RunRow) : undefined;
  },

  async upsert(run: IngestionRun): Promise<void> {
    const db = getClient();
    const { error } = await db
      .from('ingestion_runs')
      .upsert({
        run_id:               run.runId,
        started_at:           run.startedAt,
        ended_at:             run.endedAt ?? null,
        parser_version:       run.parserVersion,
        status:               run.status,
        companies_attempted:  run.companiesAttempted,
        companies_completed:  run.companiesCompleted,
        companies_partial:    run.companiesPartial,
        companies_failed:     run.companiesFailed,
        filings_discovered:   run.filingsDiscovered,
        filings_downloaded:   run.filingsDownloaded,
        filings_parsed:       run.filingsParsed,
        warnings_count:       run.warningsCount,
        errors:               run.errors,
      }, { onConflict: 'run_id' });
    assertNoError(error, `runs.upsert(${run.runId})`);
  },

  async getResults(runId: string): Promise<RunResult[]> {
    const db = getClient();
    const { data, error } = await db
      .from('ingestion_run_results')
      .select('*')
      .eq('run_id', runId);
    assertNoError(error, `runs.getResults(${runId})`);
    return (data as RunResultRow[]).map(rowToRunResult);
  },

  async upsertResult(result: RunResult): Promise<void> {
    const db = getClient();
    const { error } = await db
      .from('ingestion_run_results')
      .upsert({
        run_id:             result.runId,
        cik:                result.cik,
        ticker:             result.ticker,
        status:             result.status,
        failed_stage:       result.failedStage ?? null,
        filings_discovered: result.filingsDiscovered,
        filings_downloaded: result.filingsDownloaded,
        filings_parsed:     result.filingsParsed,
        warnings_count:     result.warningsCount,
        duration_ms:        result.durationMs,
        error_message:      result.errorMessage ?? null,
        started_at:         result.startedAt,
        ended_at:           result.endedAt,
      }, { onConflict: 'run_id,cik' });
    assertNoError(error, `runs.upsertResult(${result.runId}, ${result.cik})`);
  },
};
