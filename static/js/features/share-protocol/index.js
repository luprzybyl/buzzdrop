// The share protocol: creating a share (begin → seal → upload) and claiming
// one (release → decrypt → report), as typed results for a page to word.
export { claimShare, createShare, downloadShare } from './share-protocol.js';

/**
 * @typedef {import('./share-protocol.js').Payload} Payload
 * @typedef {import('./share-protocol.js').ShareOptions} ShareOptions
 * @typedef {import('./share-protocol.js').CreateDeps} CreateDeps
 * @typedef {import('./share-protocol.js').CreateResult} CreateResult
 * @typedef {import('./share-protocol.js').ClaimDeps} ClaimDeps
 * @typedef {import('./share-protocol.js').ClaimResult} ClaimResult
 */
