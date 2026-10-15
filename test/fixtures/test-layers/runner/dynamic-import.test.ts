export const run = async () => {
  const { spawnProcess } = await import('../../../../scripts/process-runner.ts');
  return spawnProcess;
};
