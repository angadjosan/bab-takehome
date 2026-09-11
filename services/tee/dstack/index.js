// Re-export of the pinned dstack SDK (0.5.8, the frozen v0 guest-agent API: GetKey/GetQuote/Info).
// Do not bump without switching to DstackClientV0: the unreleased 0.6 v1 getKey derives different
// key bytes, which would change the TEE signer.
export { DstackClient } from '@phala/dstack-sdk';
