import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("points the symphony bin to the emitted build entrypoint", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));

    expect(pkg.bin.symphony).toBe("dist/src/cli.js");
  });
});
