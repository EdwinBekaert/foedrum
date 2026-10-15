export type Run = (file: string, args: string[]) => Promise<string>;

export const fakeRunner: Run = async (file, args) => [file, ...args].join(' ');
