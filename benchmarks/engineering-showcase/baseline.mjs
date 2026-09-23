// Deliberately flawed starting point for the recorded engineering case.
export function createLedger() {
  const completed = new Map();
  return {
    async deliver({ tenant, eventId }, apply) {
      if (completed.has(eventId)) return completed.get(eventId);
      const result = await apply({ tenant, eventId });
      completed.set(eventId, result);
      return result;
    },
  };
}
