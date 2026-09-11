/** Shared zod primitives. */
import { z } from 'zod';

/** Lowercase 0x bytes32 hex (what sha256Hex / keccak produce). */
export const zBytes32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'expected lowercase 0x-prefixed bytes32 hex');
/** Address, any case. */
export const zAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected 0x-prefixed 20-byte address');
/** Address, lowercase only (canonical documents). */
export const zAddressLower = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected lowercase 0x-prefixed address');
/** Non-negative integer as a decimal string (uint256-safe). */
export const zUintString = z.string().regex(/^(0|[1-9][0-9]*)$/, 'expected a decimal integer string');
/** ISO-8601 UTC timestamp. */
export const zIsoDate = z.iso.datetime();
export const zNonNegInt = z.number().int().nonnegative();
export const zPosInt = z.number().int().positive();
