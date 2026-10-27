import { describe, expect, test } from "bun:test";
import { ApiClient } from "../../src/http";
import { CliError } from "../../src/errors";

type Reply = { status: number; body?: string; headers?: Record<string, string> } | "network" | "timeout";

function client(replies: Reply[], opts: { readOnly?: boolean } = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(url)}`);
    const r = replies.shift() ?? { status: 200, body: "[]" };
    if (r === "network") throw new TypeError("fetch failed");
    if (r === "timeout") throw new DOMException("timed out", "TimeoutError");
    return new Response(r.body ?? "", { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const c = new ApiClient({ baseUrl: "https://x", getToken: async () => "secret-token", fetch: fakeFetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, ...opts });
  return { c, calls, sleeps };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as CliError).code;
  }
  return "OK";
};

describe("ApiClient", () => {
  test("reads retry on 5xx and network errors with jittered backoff", async () => {
    const { c, calls, sleeps } = client([{ status: 502 }, "network", { status: 200, body: "[1]" }]);
    expect(await c.get("/project")).toEqual([1]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });
  test("rate limits honour Retry-After, for reads and writes", async () => {
    const { c, sleeps } = client([{ status: 429, headers: { "Retry-After": "7" } }, { status: 200, body: "{}" }]);
    await c.write("POST", "/task", {});
    expect(sleeps).toEqual([7000]);
    const r = client([{ status: 500, body: '{"errorCode":"exceed_query_limit"}' }, { status: 200, body: "[]" }]);
    expect(await r.c.get("/project")).toEqual([]);
  });
  test("gives up with RATE_LIMITED after the retry budget", async () => {
    const { c, calls } = client(Array(5).fill({ status: 429 }));
    expect(await code(c.get("/project"))).toBe("RATE_LIMITED");
    expect(calls).toHaveLength(4);
  });
  test("a write that times out is UNCERTAIN_WRITE and is never repeated", async () => {
    const { c, calls } = client(["timeout"]);
    expect(await code(c.write("POST", "/task", { title: "x" }))).toBe("UNCERTAIN_WRITE");
    expect(calls).toHaveLength(1);
  });
  test("a write answered with 5xx is UNCERTAIN_WRITE and is never repeated", async () => {
    const { c, calls } = client([{ status: 503 }]);
    expect(await code(c.write("POST", "/task", {}))).toBe("UNCERTAIN_WRITE");
    expect(calls).toHaveLength(1);
  });
  test("maps 401/403/404 and does not retry 4xx", async () => {
    expect(await code(client([{ status: 401 }]).c.get("/a"))).toBe("AUTH_INVALID");
    expect(await code(client([{ status: 403 }]).c.get("/a"))).toBe("PERMISSION_DENIED");
    const nf = client([{ status: 404, body: '{"errorCode":"resource_not_found","errorMessage":"task not found"}' }]);
    expect(await code(nf.c.get("/a"))).toBe("NOT_FOUND");
    expect(nf.calls).toHaveLength(1);
  });
  test("error messages never echo raw bodies or the token", async () => {
    const { c } = client([{ status: 400, body: "<html>secret-token internal trace</html>" }]);
    try {
      await c.get("/a");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-token");
      expect((e as Error).message).not.toContain("trace");
    }
  });
  test("identical GETs in one command hit the network once", async () => {
    const { c, calls } = client([{ status: 200, body: "[1]" }]);
    await Promise.all([c.get("/project"), c.get("/project")]);
    expect(calls).toHaveLength(1);
  });
  test("read-only mode refuses writes before any request", async () => {
    const { c, calls } = client([], { readOnly: true });
    expect(() => c.write("POST", "/task", {})).toThrow();
    expect(calls).toHaveLength(0);
  });
});
