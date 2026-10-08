export const LIVE_LIMITS = {
  maxGuests: 8,
  maxControlFrameBytes: 16 * 1024 * 1024,
  maxPresenceBytes: 32 * 1024,
  maxPresencePerSecond: 30,
  maxAssetBytes: 100 * 1024 * 1024,
  assetChunkBytes: 48 * 1024,
  revisionRing: 32,
  revisionRingBytes: 20 * 1024 * 1024,
  approvalTimeoutMs: 60_000,
  secretFailures: 3,
  editingLockMs: 30_000,
  reconnectMaxMs: 10 * 60 * 1000,
  onlineTimeoutMs: 15_000,
  stateDebounceMs: 40,
  guestFlushMs: 2_000,
  mirrorMaxAgeMs: 7 * 24 * 60 * 60 * 1000
} as const;
