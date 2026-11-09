/*
 * Provenance: wip3l/qingye-reader commit 8a783195b0da9191742e41f32086d084017439c3 (2026-10-24, GPL-3.0),
 * entry/src/main/ets/core/reader/ReaderComicComputeQueue.ts. Modified for R-HUA/legado-harmony: none (verbatim); colorization no longer shares the queue.
 */
/** Keep coloring and super-resolution native allocations from overlapping during mode switches. */
export class ReaderComicComputeQueue {
  private static tail: Promise<void> = Promise.resolve();

  static run<T>(work: () => Promise<T>): Promise<T> {
    const task = ReaderComicComputeQueue.tail.then(work);
    ReaderComicComputeQueue.tail = task.then((): void => {}, (): void => {});
    return task;
  }
}
