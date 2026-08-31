const ZERO = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheSavingsUsd: 0,
  costUsd: 0,
});

function add(left = ZERO, right) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cacheSavingsUsd: left.cacheSavingsUsd + right.cacheSavingsUsd,
    costUsd: left.costUsd + right.costUsd,
  };
}

function valid(vector) {
  return Number.isSafeInteger(vector.inputTokens)
    && Number.isSafeInteger(vector.outputTokens)
    && Number.isSafeInteger(vector.cacheReadTokens)
    && Number.isSafeInteger(vector.cacheWriteTokens)
    && Number.isFinite(vector.cacheSavingsUsd)
    && Number.isFinite(vector.costUsd);
}

/** Exact synchronous fake for reducer/engine tests; production always uses SQLite. */
export function createUsageRecorder() {
  const events = new Map();
  let session = ZERO;
  let main = undefined;
  const agents = new Map();
  const routes = new Map();
  const snapshot = () => ({
    session,
    byMain: main ? [{ mainId: "main", totals: main }] : [],
    byAgent: [...agents].map(([agentId, totals]) => ({ agentId, totals })),
    byRoute: [...routes].map(([key, totals]) => {
      const [provider, model] = key.split("\0");
      return { provider, model, totals };
    }),
  });
  return {
    recordUsage(input) {
      const fingerprint = JSON.stringify(input);
      const existing = events.get(input.eventId);
      if (existing !== undefined) {
        return existing === fingerprint
          ? { kind: "duplicate", mainId: "main", totals: snapshot() }
          : { kind: "scope_mismatch" };
      }
      const nextSession = add(session, input.counters);
      const nextScope = input.agentId
        ? add(agents.get(input.agentId), input.counters)
        : add(main, input.counters);
      const routeKey = `${input.route.provider}\0${input.route.model}`;
      const nextRoute = add(routes.get(routeKey), input.counters);
      if (!valid(nextSession) || !valid(nextScope) || !valid(nextRoute)) {
        throw new RangeError("usage totals overflow");
      }
      events.set(input.eventId, fingerprint);
      session = nextSession;
      if (input.agentId) {
        agents.set(input.agentId, nextScope);
      } else {
        main = nextScope;
      }
      routes.set(routeKey, nextRoute);
      return { kind: "recorded", mainId: "main", totals: snapshot() };
    },
  };
}
