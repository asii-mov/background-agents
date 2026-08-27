import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { handleRequest, npmAuthLine, selectExecutable, verifyRootLock } from "./server.js";

const validBuildRequest = {
  packageName: "@company/mcp",
  version: "1.2.3",
  integrity: "sha512-root",
  registryUrl: "https://registry.example/private",
  tarballUrl: "https://registry.example/private/mcp.tgz",
  executable: "mcp",
};

async function postBuildRequest(body: unknown): Promise<Response> {
  const server = createServer((request, response) => void handleRequest(request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Builder did not bind TCP");
  const previousToken = process.env.MCP_ARTIFACT_BUILDER_TOKEN;
  process.env.MCP_ARTIFACT_BUILDER_TOKEN = "builder-secret";
  try {
    return await fetch(`http://127.0.0.1:${address.port}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer builder-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } finally {
    if (previousToken === undefined) delete process.env.MCP_ARTIFACT_BUILDER_TOKEN;
    else process.env.MCP_ARTIFACT_BUILDER_TOKEN = previousToken;
    server.close();
    await once(server, "close");
  }
}

describe("MCP artifact builder", () => {
  it("scopes npm credentials to the configured registry path", () => {
    assert.equal(
      npmAuthLine("https://registry.example/private", "secret"),
      "//registry.example/private/:_authToken=secret"
    );
  });

  it("rejects an ambiguous or undeclared executable", () => {
    assert.equal(selectExecutable("@company/mcp", { one: "one.js" }, "one"), "one");
    assert.throws(() => selectExecutable("@company/mcp", { one: "one.js" }, "two"));
  });

  it("verifies the root package version and registry integrity", () => {
    const lock = {
      packages: { "node_modules/@company/mcp": { version: "1.2.3", integrity: "sha512-root" } },
    };
    assert.doesNotThrow(() => verifyRootLock(lock, "@company/mcp", "1.2.3", "sha512-root"));
    assert.throws(() => verifyRootLock(lock, "@company/mcp", "1.2.4", "sha512-root"));
  });

  it("rejects invalid build fields at the HTTP boundary", async () => {
    const cases = [
      [{ ...validBuildRequest, registryToken: 42 }, "registryToken must be a string"],
      [{ ...validBuildRequest, registryUrl: "http://registry.example" }, "must use HTTPS"],
      [{ ...validBuildRequest, executable: "bin/mcp" }, "executable must be a bin name"],
    ] as const;

    for (const [body, expectedError] of cases) {
      const response = await postBuildRequest(body);
      assert.equal(response.status, 400);
      assert.match(await response.text(), new RegExp(expectedError));
    }
  });
});
