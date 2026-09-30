export async function runWithConcurrency(
  taskCount: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < taskCount) {
      const index = nextIndex;
      nextIndex += 1;
      await task(index);
    }
  }

  const workerCount = Math.min(taskCount, concurrency);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
