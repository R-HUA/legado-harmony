export interface SourceQuota { count: number; maxCount: number | null; maxBytes: number | null; }

/** Existing excess data may shrink or be deleted, never silently removed. */
export function sourceQuotaError(quota: SourceQuota, existed: boolean, before: number, after: number): string | null {
  if (after === 0) return null;
  if (quota.maxBytes !== null && after > quota.maxBytes && (!existed || after > before)) {
    return `单个书源超过当前账号的 ${quota.maxBytes / 1024} KiB 云同步限额`;
  }
  if (!existed && quota.maxCount !== null && quota.count >= quota.maxCount) {
    return `书源云同步已达到 ${quota.maxCount} 个，已有书源仍可下载或删除`;
  }
  return null;
}
