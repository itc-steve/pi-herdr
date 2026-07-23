import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertLaneAvailable,
  assertMultiWriterOwns,
  LaneError,
  normalizeLanePath,
  parsePathList,
  pathsOverlap,
} from "../src/lanes.ts";

describe("lanes", () => {
  it("normalizes and rejects escapes", () => {
    assert.equal(normalizeLanePath("./src/a"), "src/a");
    assert.throws(() => normalizeLanePath("../x"), LaneError);
    assert.throws(() => normalizeLanePath("/abs"), LaneError);
  });

  it("detects overlaps", () => {
    assert.equal(pathsOverlap("src", "src/a"), true);
    assert.equal(pathsOverlap("src/a", "src/b"), false);
  });

  it("rejects overlapping in-flight owns", () => {
    assert.throws(
      () =>
        assertLaneAvailable({
          key: "j2",
          owns: parsePathList("src/auth/"),
          inFlight: [{ key: "j1", owns: ["src/auth/login.ts"] }],
        }),
      LaneError,
    );
  });

  it("requires owns when another writer is flying", () => {
    assert.throws(
      () =>
        assertMultiWriterOwns({
          owns: [],
          inFlight: [{ key: "j1", owns: ["src/a"] }],
        }),
      /owns=/,
    );
  });

  it("allows non-writer with no owns when no writers", () => {
    assert.doesNotThrow(() =>
      assertMultiWriterOwns({ owns: [], inFlight: [] }),
    );
  });
});
