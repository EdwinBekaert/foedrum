export const run = async () => {
  const { spawn } = await import('node:child_process');
  return spawn;
};
