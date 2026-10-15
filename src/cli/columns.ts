// Aligned columns for the terminal: each cell but the last padded to its column's widest, two
// spaces apart, without trailing spaces.

export const columns = (rows: readonly (readonly string[])[], indent = '  '): string[] => {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) => {
    const cells = row.map((cell, i) =>
      i < row.length - 1 ? cell.padEnd((widths[i] ?? 0) + 2) : cell,
    );
    return `${indent}${cells.join('')}`.trimEnd();
  });
};
