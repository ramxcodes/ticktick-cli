import { expect, test } from "bun:test";
import { API_HOST } from "../../src/auth";
import { configDir } from "../../src/config";
import { tmpdir } from "os";

// Guards from tests/setup.ts: if the preload stops loading, these fail before any test can touch real data.
test("tests cannot reach the real TickTick API or the real config dir", async () => {
  await expect(fetch(`${API_HOST()}/open/v1/project`)).rejects.toThrow("Blocked network access");
  expect(configDir().startsWith(tmpdir())).toBe(true);
  expect(process.env.TICKTICK_TOKEN).toBeUndefined();
});
