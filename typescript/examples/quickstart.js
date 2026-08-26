import { GridCarbon } from "gridcarbon";

const gc = new GridCarbon();

// 1. One zone, right now.
const de = await gc.latest("DE");
console.log(`${de.zone}  ${de.gco2eqPerKwh} gCO2eq/kWh  @ ${de.ts.toISOString()}  (${de.method})`);

// 2. Cleanest lifecycle-comparable zones. GB is excluded automatically:
//    its numbers come from NESO and use operational, not lifecycle, factors.
const all = await gc.latest();
const cleanest = all
  .filter((r) => r.isLifecycle)
  .sort((a, b) => a.gco2eqPerKwh - b.gco2eqPerKwh)
  .slice(0, 3);
console.log("\ncleanest comparable zones:");
for (const r of cleanest) console.log(`  ${r.zone.padEnd(12)} ${String(r.gco2eqPerKwh).padStart(6)}`);

// 3. A window. Always check `truncated` before averaging.
const end = new Date();
const start = new Date(end.getTime() - 6 * 3600 * 1000);
const series = await gc.series("DE", { start, end });
const mean = series.readings.reduce((s, r) => s + r.gco2eqPerKwh, 0) / series.count;
console.log(
  `\nDE last 6h: ${series.count} points, truncated=${series.truncated}, mean=${mean.toFixed(1)} gCO2eq/kWh`,
);
