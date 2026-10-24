// The phone signing page belongs to the separately shipped runner, so a plain
// memory install must not expose it. Served only with
// ONEMEMORY_ENABLE_SIGN_PAGE=1; otherwise /sign and /signer.js are 404.
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";

describe("sign page gating", () => {
  let store: Store;
  let baseUrl: string;
  let server: ReturnType<typeof createApiServer>;

  before(async () => {
    store = new Store(":memory:");
    server = createApiServer(store, "sign-page-token");
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  afterEach(() => delete process.env.ONEMEMORY_ENABLE_SIGN_PAGE);

  test("off by default: /sign and /signer.js are 404", async () => {
    delete process.env.ONEMEMORY_ENABLE_SIGN_PAGE;
    for (const p of ["/sign", "/signer.js"]) {
      const res = await fetch(baseUrl + p);
      assert.equal(res.status, 404, `${p} must not be served by default`);
      await res.text();
    }
  });

  test("only the exact value 1 enables it", async () => {
    process.env.ONEMEMORY_ENABLE_SIGN_PAGE = "true";
    const res = await fetch(baseUrl + "/sign");
    assert.equal(res.status, 404);
    await res.text();
  });

  test("ONEMEMORY_ENABLE_SIGN_PAGE=1 serves the page", async () => {
    process.env.ONEMEMORY_ENABLE_SIGN_PAGE = "1";
    const res = await fetch(baseUrl + "/sign");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Check a result/);
  });
});
