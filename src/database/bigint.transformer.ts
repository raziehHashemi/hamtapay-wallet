import { ValueTransformer } from 'typeorm';

/** BIGINT ⇄ bigint. The pg driver returns int8 as string; we never let it pass through `number`. */
export const bigintTransformer: ValueTransformer = {
  to: (value: bigint | null | undefined) =>
    value === null || value === undefined ? value : value.toString(),
  from: (value: string | null | undefined) => (value === null || value === undefined ? value : BigInt(value)),
};
