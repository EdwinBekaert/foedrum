// Building blocks shared by the recipe, brewer and configuration schemas.

import { z } from './zod.ts';

const notImplemented = (): never => {
  throw new Error('not implemented');
};
const stub = () => z.unknown().transform(notImplemented);

export const Duration = stub();
export const RelativePath = stub();
export const CheckName = stub();
export const Command = stub();
export const CommandObject = stub();
export const ToolRule = stub();
export const AllowedTool = stub();

export function withinCeiling(_entry: string, _ceiling: readonly string[]): boolean {
  return notImplemented();
}
