/** Fixture effects only, not production execution/permission or rollback.
 * Withdraw work and observe settlement before filesystem removal. Unknown work,
 * failed release or retained ownership must never be hidden by deleting the root. */
export async function teardownOwnedFixture(io: {
  stop(): Promise<void>;
  invocations(): readonly Promise<unknown>[];
  release(): Promise<void>;
  hasMarker(): Promise<boolean>;
  remove(): Promise<void>;
  reset(): void;
}): Promise<{ removed: boolean }> {
  try {
    await io.stop();
    const settled = await Promise.allSettled(io.invocations());
    await io.release();
    if (settled.some(result => result.status === "rejected") || await io.hasMarker()) return { removed: false };
    await io.remove();
    return { removed: true };
  } finally { io.reset(); }
}
