import { NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/api/adminAuth';
import { getReviewItemsRepo } from '@/lib/db/repositories';
import type { ReviewStatus } from '@/lib/anomaly/types';

const VALID_STATUSES = new Set<ReviewStatus>([
  'open',
  'investigating',
  'confirmed_bug',
  'expected_behavior',
  'resolved',
  'ignored',
]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { id } = await params;

  let body: { status?: unknown; resolutionNote?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status as ReviewStatus)) {
    return NextResponse.json(
      { error: `Invalid or missing status. Must be one of: ${[...VALID_STATUSES].join(', ')}` },
      { status: 400 },
    );
  }

  const resolutionNote =
    typeof body.resolutionNote === 'string' ? body.resolutionNote : undefined;

  const repo = await getReviewItemsRepo();
  await repo.updateStatus(id, body.status as ReviewStatus, resolutionNote);

  return NextResponse.json({ ok: true });
}
