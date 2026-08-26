/** Shared test doubles. No network is touched by any of these. */

/** Build a JSON `Response`, the way the live API sends it. */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch stub that replays canned responses and records every call.
 * `handler` receives (url, init) and returns a Response (or throws).
 */
export function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

/** Replay a fixed sequence of responses, one per call. */
export function stubSequence(...responses) {
  return stubFetch((_url, _init, i) => {
    const r = responses[i];
    if (r === undefined) throw new Error(`unexpected extra fetch call #${i}`);
    return typeof r === "function" ? r() : r;
  });
}

/** A fetch that never settles until its signal aborts. */
export function hangingFetch() {
  return stubFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        const fail = () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      }),
  );
}

/** Capture console.warn for the duration of `fn`. */
export async function captureWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/** Fixtures copied verbatim from live API responses on 2026-08-26. */
export const ZONES_BODY = {
  data: [
    { zone: "AT", name: "Austria", source: "entsoe", resolution_min: 60 },
    { zone: "DE", name: "Germany-Luxembourg", source: "entsoe", resolution_min: 60 },
    { zone: "GB", name: "Great Britain", source: "uk-neso", resolution_min: 30 },
    { zone: "US-CAL-CISO", name: "CAISO (California)", source: "eia", resolution_min: 60 },
  ],
};

export const LATEST_ALL_BODY = {
  unit: "gCO2eq/kWh",
  data: [
    { zone: "AT", ts: "2026-08-26T01:00:00Z", gco2eq_kwh: 54.9, method: "computed:v1" },
    { zone: "DE", ts: "2026-08-26T01:00:00Z", gco2eq_kwh: 371.4, method: "computed:v1" },
    { zone: "GB", ts: "2026-08-26T01:30:00Z", gco2eq_kwh: 114, method: "upstream:uk-neso:forecast" },
  ],
};

export const LATEST_DE_BODY = {
  unit: "gCO2eq/kWh",
  data: [{ zone: "DE", ts: "2026-08-26T01:00:00Z", gco2eq_kwh: 371.4, method: "computed:v1" }],
};

/** Note: series items carry NO `zone` - it lives on the envelope. */
export const SERIES_DE_BODY = {
  zone: "DE",
  from: "2026-08-25T18:00:00Z",
  to: "2026-08-26T00:00:00Z",
  unit: "gCO2eq/kWh",
  count: 3,
  truncated: false,
  data: [
    { ts: "2026-08-25T18:00:00Z", gco2eq_kwh: 380.7, method: "computed:v1" },
    { ts: "2026-08-25T19:00:00Z", gco2eq_kwh: 365, method: "computed:v1" },
    { ts: "2026-08-25T20:00:00Z", gco2eq_kwh: 359.1, method: "computed:v1" },
  ],
};

export const SERIES_TRUNCATED_BODY = {
  zone: "DE",
  from: "2026-08-01T00:00:00Z",
  to: "2026-08-26T00:00:00Z",
  unit: "gCO2eq/kWh",
  count: 2,
  truncated: true,
  note: "Result capped at 5000 points. Narrow the window with 'from'/'to' to get the rest.",
  data: [
    { ts: "2026-08-01T00:00:00Z", gco2eq_kwh: 400, method: "computed:v1" },
    { ts: "2026-08-01T01:00:00Z", gco2eq_kwh: 401, method: "computed:v1" },
  ],
};

export const SERIES_EMPTY_BODY = {
  zone: "DE",
  from: "2026-01-01T00:00:00Z",
  to: "2026-01-02T00:00:00Z",
  unit: "gCO2eq/kWh",
  count: 0,
  truncated: false,
  data: [],
};
