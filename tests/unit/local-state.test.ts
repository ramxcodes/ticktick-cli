import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, symlink, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, saveConfig, securityNotices } from "../../src/config";
import { findOp, resolveOp, runOnce } from "../../src/ops";
import { CliError } from "../../src/errors";
import { matchByName, resolveProject } from "../../src/resolve";
import { ReadCache } from "../../src/cache";
import { ApiClient } from "../../src/http";

// Restore the suite-wide temp dir from tests/setup.ts, so later tests never fall back to the real config dir.
const suiteConfigDir = process.env.TICKTICK_CONFIG_DIR!;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tt-test-"));
  process.env.TICKTICK_CONFIG_DIR = join(dir, "cfg");
});
afterEach(async () => {
  process.env.TICKTICK_CONFIG_DIR = suiteConfigDir;
  await rm(dir, { recursive: true, force: true });
});

const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe("config security", () => {
  test("creates the directory 700 and the file 600", async () => {
    await saveConfig({ timezone: "UTC" });
    expect(await mode(join(dir, "cfg"))).toBe(0o700);
    expect(await mode(join(dir, "cfg", "config.json"))).toBe(0o600);
    expect(await loadConfig()).toEqual({ timezone: "UTC" });
  });
  test("repairs loose permissions on read and reports it", async () => {
    await saveConfig({ accessToken: "x" });
    await chmod(join(dir, "cfg"), 0o775);
    await chmod(join(dir, "cfg", "config.json"), 0o664);
    securityNotices.length = 0;
    await loadConfig();
    expect(await mode(join(dir, "cfg"))).toBe(0o700);
    expect(await mode(join(dir, "cfg", "config.json"))).toBe(0o600);
    expect(securityNotices).toHaveLength(2);
  });
  test("refuses a symlinked credential file", async () => {
    await mkdir(join(dir, "cfg"), { mode: 0o700 });
    await writeFile(join(dir, "elsewhere.json"), "{}");
    await symlink(join(dir, "elsewhere.json"), join(dir, "cfg", "config.json"));
    await expect(loadConfig()).rejects.toMatchObject({ code: "INSECURE_CREDENTIALS" });
  });
  test("refuses a symlinked directory", async () => {
    await mkdir(join(dir, "real"), { mode: 0o700 });
    await symlink(join(dir, "real"), join(dir, "cfg"));
    await expect(saveConfig({})).rejects.toMatchObject({ code: "INSECURE_CREDENTIALS" });
  });
});

describe("idempotency ledger", () => {
  const ok = (id: string) => async () => ({ result: id, record: { taskId: id, projectId: "p" } });

  test("the same op id and request runs once, then replays", async () => {
    let runs = 0;
    const exec = async () => ({ result: `r${++runs}`, record: { taskId: "t1", projectId: "p" } });
    expect(await runOnce("op1", "task.create", { a: 1 }, exec)).toEqual({ replayed: false, value: "r1" });
    expect(await runOnce("op1", "task.create", { a: 1 }, exec)).toMatchObject({ replayed: true, record: { taskId: "t1" } });
    expect(runs).toBe(1);
  });
  test("reusing an op id for a different request is rejected", async () => {
    await runOnce("op2", "task.create", { a: 1 }, ok("t"));
    await expect(runOnce("op2", "task.create", { a: 2 }, ok("t"))).rejects.toMatchObject({ code: "OP_ID_CONFLICT" });
  });
  test("an uncertain outcome blocks retries until resolved", async () => {
    const lost = async (): Promise<never> => {
      throw new CliError("UNCERTAIN_WRITE", "timeout");
    };
    await expect(runOnce("op3", "task.create", {}, lost, { title: "x", projectId: "p" })).rejects.toMatchObject({ code: "UNCERTAIN_WRITE" });
    expect(await findOp("op3")).toMatchObject({ state: "uncertain", title: "x", projectId: "p" });
    let runs = 0;
    await expect(runOnce("op3", "task.create", {}, async () => ({ result: ++runs, record: {} }))).rejects.toMatchObject({ code: "UNCERTAIN_WRITE" });
    expect(runs).toBe(0);
    await resolveOp("op3", { taskId: "t9", projectId: "p" });
    expect(await runOnce("op3", "task.create", {}, async () => ({ result: ++runs, record: {} }))).toMatchObject({ replayed: true, record: { taskId: "t9" } });
    expect(runs).toBe(0);
  });
  test("a definite rejection frees the op id", async () => {
    const reject = async (): Promise<never> => {
      throw new CliError("INVALID_ARGUMENT", "bad");
    };
    await expect(runOnce("op4", "task.create", {}, reject)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await runOnce("op4", "task.create", {}, ok("t"))).toMatchObject({ replayed: false });
  });
  test("concurrent runs of one op id execute once", async () => {
    let runs = 0;
    const slow = async () => {
      runs++;
      await Bun.sleep(30);
      return { result: "x", record: { taskId: "t", projectId: "p" } };
    };
    const results = await Promise.all([1, 2, 3].map(() => runOnce("op5", "task.create", {}, slow)));
    expect(runs).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(2);
  });
});

describe("name resolution", () => {
  const items = [{ n: "Work" }, { n: "💼Work - ASBL" }, { n: "Home" }, { n: "home office" }];
  const m = (q: string) => matchByName(items, q, (i) => i.n, (i) => i.n, "project");
  test("exact (case-insensitive) beats partial", () => expect(m("work").item.n).toBe("Work"));
  test("a unique partial match is accepted and labelled", () => expect(m("asbl")).toMatchObject({ item: { n: "💼Work - ASBL" }, matchedBy: "partial" }));
  test("several exact or partial matches are AMBIGUOUS, never the first", () => {
    expect(() => m("o")).toThrow(expect.objectContaining({ code: "AMBIGUOUS" }));
    expect(() => matchByName([{ n: "A" }, { n: "a" }], "a", (i) => i.n, (i) => i.n, "task")).toThrow(expect.objectContaining({ code: "AMBIGUOUS" }));
  });
  test("ids win over names", () => {
    expect(resolveProject([{ id: "Home", name: "x" }, { id: "2", name: "Home" }], "Home").project.id).toBe("Home");
  });
});

describe("read cache", () => {
  const clientFor = (token: string, cache: ReadCache, calls: string[]) =>
    new ApiClient({
      baseUrl: "https://x",
      getToken: async () => token,
      cache,
      fetch: (async () => {
        calls.push(token);
        return Response.json([token]);
      }) as unknown as typeof fetch,
    });

  test("serves fresh entries, reports their age, and never crosses accounts", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    const first = new ReadCache(60, () => now);
    expect(await clientFor("token-a", first, calls).get("/project")).toEqual(["token-a"]);
    await first.flush();

    now += 30_000;
    const second = new ReadCache(60, () => now);
    expect(await clientFor("token-a", second, calls).get("/project")).toEqual(["token-a"]);
    expect(second.stats).toMatchObject({ hits: 1, oldestHitAgeSeconds: 30 });
    expect(await clientFor("token-b", second, calls).get("/project")).toEqual(["token-b"]);
    expect(calls).toEqual(["token-a", "token-b"]);
  });

  test("expired entries are refetched", async () => {
    let now = 0;
    const calls: string[] = [];
    const c1 = new ReadCache(10, () => now);
    await clientFor("t", c1, calls).get("/project");
    await c1.flush();
    now = 11_000;
    await clientFor("t", new ReadCache(10, () => now), calls).get("/project");
    expect(calls).toHaveLength(2);
  });
});
