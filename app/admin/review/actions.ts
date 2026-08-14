'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdminCookie } from '@/lib/admin/cookieAuth';
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

export async function updateItemStatus(formData: FormData): Promise<void> {
  await requireAdminCookie();

  const id              = String(formData.get('id') ?? '').trim();
  const status          = String(formData.get('status') ?? '') as ReviewStatus;
  const resolutionNote  = String(formData.get('resolutionNote') ?? '').trim() || undefined;

  if (!id || !VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: "${status}". Must be one of: ${[...VALID_STATUSES].join(', ')}`);
  }

  const repo = await getReviewItemsRepo();
  await repo.updateStatus(id, status, resolutionNote);

  revalidatePath(`/admin/review/${id}`);
  redirect(`/admin/review/${id}`);
}
