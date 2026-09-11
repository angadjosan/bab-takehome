import { loadAbi } from '@envmarket/shared';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { describe, expect, it } from 'vitest';
import { revertReason } from '../src/market.ts';

const abi = loadAbi('EnvMarket');

describe('revertReason', () => {
  it('decodes a custom error selector viem could not decode, as one line', () => {
    // viem built without the market ABI -> undecoded signature (what the keeper saw in logs)
    const inner = new ContractFunctionRevertedError({ abi: [], data: '0xde4168ba', functionName: 'selectJurors' });
    const outer = new ContractFunctionExecutionError(inner, { abi: [], functionName: 'selectJurors' });
    expect(revertReason(outer, abi)).toBe('WrongState');
    expect(revertReason(inner, abi)).toBe('WrongState');
  });

  it('decodes errors with arguments, whether or not viem had the ABI', () => {
    const data = encodeErrorResult({ abi, errorName: 'InsufficientStake', args: [5n, 20n] });
    const withAbi = new ContractFunctionRevertedError({ abi, data, functionName: 'withdrawJurorStake' });
    const withoutAbi = new ContractFunctionRevertedError({ abi: [], data, functionName: 'withdrawJurorStake' });
    expect(revertReason(withAbi, abi)).toBe('InsufficientStake(5,20)');
    expect(revertReason(withoutAbi, abi)).toBe('InsufficientStake(5,20)');
  });

  it('reports an unknown selector compactly', () => {
    const inner = new ContractFunctionRevertedError({ abi: [], data: '0x12345678', functionName: 'x' });
    expect(revertReason(inner, abi)).toBe('revert 0x12345678');
  });

  it('falls back to a single line for non-contract errors', () => {
    expect(revertReason(new Error('boom\nstack'))).toBe('boom');
  });
});
