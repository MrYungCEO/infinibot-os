/**
 * mic-arbiter — one microphone owner at a time on the Infini page.
 *
 * iOS allows one active recording per audio session. Three recorders want the
 * mic here: the "Hey Infini" wake listener, the call, and the options sheet's
 * "Test phrase". Each registers a `release()` that stops (and finalises) its
 * recorder; `acquire(owner)` awaits the current owner's release before
 * handing the mic over, and every hand-off is serialised so two acquires
 * never interleave.
 *
 * Pure JS (no RN) so jest can drive the hand-off order.
 */

export function createMicArbiter() {
  const releasers = new Map();
  let owner = null;
  let chain = Promise.resolve();
  const log = [];

  function register(name, release) {
    releasers.set(name, release);
    return () => {
      if (releasers.get(name) === release) releasers.delete(name);
      if (owner === name) owner = null;
    };
  }

  /** Take the mic: the previous owner is stopped and released first. */
  function acquire(name) {
    const step = chain.then(async () => {
      if (owner && owner !== name) {
        const prev = owner;
        log.push(`release:${prev}`);
        try {
          await releasers.get(prev)?.();
        } catch {
          /* a failed stop still frees the slot */
        }
        if (owner === prev) owner = null;
      }
      owner = name;
      log.push(`acquire:${name}`);
    });
    chain = step.catch(() => {});
    return step;
  }

  /** Give the mic back (no-op when someone else owns it). */
  function release(name) {
    if (owner === name) {
      owner = null;
      log.push(`free:${name}`);
    }
  }

  return {
    register,
    acquire,
    release,
    get owner() {
      return owner;
    },
    log,
  };
}

/** The app-wide arbiter. */
export const micArbiter = createMicArbiter();
