import assert from "node:assert/strict";
import test from "node:test";
import { ExpiringSingleFlight } from "../../src/utils/expiringSingleFlight.ts";

test("shares one loader and reuses a successful value until TTL expiry", async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new ExpiringSingleFlight<number>({
    ttlMs: 100,
    maxEntries: 4,
    now: () => now,
  });
  const loader = async () => {
    loads += 1;
    return loads;
  };

  const [first, concurrent] = await Promise.all([
    cache.run("viewer", loader),
    cache.run("viewer", loader),
  ]);
  assert.equal(first, 1);
  assert.equal(concurrent, 1);
  assert.equal(loads, 1);

  assert.equal(await cache.run("viewer", loader), 1);
  now += 101;
  assert.equal(await cache.run("viewer", loader), 2);
});

test("does not cache rejected or explicitly non-cacheable results", async () => {
  let loads = 0;
  const cache = new ExpiringSingleFlight<{ ok: boolean }>({
    ttlMs: 100,
    maxEntries: 4,
    shouldCache: (value) => value.ok,
  });

  await assert.rejects(cache.run("error", async () => {
    loads += 1;
    throw new Error("failed");
  }));
  await assert.rejects(cache.run("error", async () => {
    loads += 1;
    throw new Error("failed again");
  }));

  assert.deepEqual(await cache.run("result", async () => {
    loads += 1;
    return { ok: false };
  }), { ok: false });
  assert.deepEqual(await cache.run("result", async () => {
    loads += 1;
    return { ok: true };
  }), { ok: true });
  assert.equal(loads, 4);
});

test("clear during a request prevents its stale result from being cached", async () => {
  let resolveFirst!: (value: number) => void;
  let loads = 0;
  const cache = new ExpiringSingleFlight<number>({ ttlMs: 1_000, maxEntries: 4 });
  const first = cache.run("viewer", () => {
    loads += 1;
    return new Promise<number>((resolve) => {
      resolveFirst = resolve;
    });
  });

  await Promise.resolve();
  cache.clear();
  resolveFirst(1);
  assert.equal(await first, 1);
  assert.equal(await cache.run("viewer", async () => {
    loads += 1;
    return 2;
  }), 2);
  assert.equal(loads, 2);
});

test("forceFresh bypasses an ordinary request but shares another fresh request", async () => {
  let resolveOrdinary!: (value: number) => void;
  let resolveFresh!: (value: number) => void;
  let loads = 0;
  const cache = new ExpiringSingleFlight<number>({ ttlMs: 1_000, maxEntries: 4 });
  const ordinary = cache.run("viewer", () => {
    loads += 1;
    return new Promise<number>((resolve) => {
      resolveOrdinary = resolve;
    });
  });
  await Promise.resolve();
  const fresh = cache.run("viewer", () => {
    loads += 1;
    return new Promise<number>((resolve) => {
      resolveFresh = resolve;
    });
  }, { forceFresh: true });
  const concurrentFresh = cache.run("viewer", async () => 99, { forceFresh: true });
  await Promise.resolve();

  assert.equal(loads, 2);
  resolveOrdinary(1);
  resolveFresh(2);
  assert.equal(await ordinary, 1);
  assert.equal(await fresh, 2);
  assert.equal(await concurrentFresh, 2);
  assert.equal(await cache.run("viewer", async () => 3), 2);
});

test("evicts the least recently used entry when bounded capacity is reached", async () => {
  let loads = 0;
  const cache = new ExpiringSingleFlight<number>({ ttlMs: 1_000, maxEntries: 2 });
  const load = async () => ++loads;

  assert.equal(await cache.run("a", load), 1);
  assert.equal(await cache.run("b", load), 2);
  assert.equal(await cache.run("a", load), 1);
  assert.equal(await cache.run("c", load), 3);
  assert.equal(await cache.run("b", load), 4);
});
