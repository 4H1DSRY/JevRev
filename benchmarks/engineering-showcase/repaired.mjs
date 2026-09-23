// The host's repaired implementation. The ledger remains an in-memory fixture;
// this case makes no claim about persistence or distributed exactly-once delivery.
export function createLedger() {
  const completed = new Map();
  const inFlight = new Map();
  return {
    async deliver({ tenant, eventId }, apply) {
      const key = JSON.stringify([tenant, eventId]);
      if (completed.has(key)) return completed.get(key);
      if (inFlight.has(key)) return inFlight.get(key);
      const attempt = Promise.resolve().then(() => apply({ tenant, eventId }));
      inFlight.set(key, attempt);
      try {
        const result = await attempt;
        completed.set(key, result);
        return result;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
