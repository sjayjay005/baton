// Delta debugging (Zeller & Hildebrandt, "Simplifying and Isolating Failure-Inducing Input", 2002).
// Finds a 1-minimal subsequence of `items` for which `fails(subset)` is still true.
// `fails` is async and expensive (a full replay), so results are cached by subset.

export async function ddmin(items, fails, { onProgress = () => {}, maxTests = 400, signal } = {}) {
  const cache = new Map();
  let tests = 0;
  const key = (subset) => subset.map((x) => items.indexOf(x)).join(',');
  const test = async (subset) => {
    const k = key(subset);
    if (cache.has(k)) return cache.get(k);
    if (signal && signal.aborted) throw new Error('Cancelled');
    if (tests >= maxTests) throw new Error(`Gave up after ${maxTests} replays`);
    tests++;
    const r = await fails(subset);
    cache.set(k, r);
    onProgress({ tests, size: current.length, tried: subset.length, failed: r });
    return r;
  };
  const split = (arr, n) => {
    const out = [];
    const size = Math.ceil(arr.length / n);
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  let current = items.slice();
  // The empty run first: if the bug happens with no actions at all, nothing is needed.
  if (await test([])) return { result: [], tests };
  let n = 2;
  while (current.length >= 2) {
    const chunks = split(current, n);
    let reduced = false;
    for (const c of chunks) {
      if (await test(c)) {
        current = c;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      for (const c of chunks) {
        const complement = current.filter((x) => !c.includes(x));
        if (complement.length && (await test(complement))) {
          current = complement;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  // A single action left: check whether even that is needed.
  if (current.length === 1 && (await test([]))) current = [];
  return { result: current, tests };
}
