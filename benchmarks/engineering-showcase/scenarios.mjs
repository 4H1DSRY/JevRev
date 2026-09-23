// Shared by the command checks and the visible replay workbench. The UI runs
// these scenarios against the actual baseline and repaired ledger modules.
export async function runScenario(createLedger, caseId) {
  if (caseId === "tenant") {
    const ledger = createLedger();
    const deliveries = [];
    for (const tenant of ["north", "south"]) {
      const eventId = "invoice-42";
      const observed = await ledger.deliver({ tenant, eventId }, ({ tenant: owner }) => `${owner}:accepted`);
      deliveries.push({ tenant, eventId, expected: `${tenant}:accepted`, observed, passed: observed === `${tenant}:accepted` });
    }
    return { case: caseId, deliveries, passed: deliveries.every((item) => item.passed) };
  }
  if (caseId === "race") {
    const ledger = createLedger();
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const apply = async () => { calls += 1; await gate; return "accepted"; };
    const event = { tenant: "north", eventId: "invoice-42" };
    const deliveries = [ledger.deliver(event, apply), ledger.deliver(event, apply)];
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all(deliveries);
    return { case: caseId, event, results, calls, expectedCalls: 1, passed: calls === 1 && results.every((value) => value === "accepted") };
  }
  if (caseId === "retry") {
    const ledger = createLedger();
    let calls = 0;
    const event = { tenant: "north", eventId: "invoice-42" };
    const apply = async () => { calls += 1; if (calls === 1) throw new Error("transient write failure"); return "accepted"; };
    let firstFailed = false;
    try { await ledger.deliver(event, apply); } catch { firstFailed = true; }
    const second = await ledger.deliver(event, apply);
    return { case: caseId, event, firstFailed, second, calls, expectedCalls: 2, passed: firstFailed && second === "accepted" && calls === 2 };
  }
  throw new Error(`unknown scenario: ${caseId}`);
}
