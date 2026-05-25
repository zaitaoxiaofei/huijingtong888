import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("3:4 canvas uses white background by default", () => {
  const script = String.raw`
import importlib.util
import json
import numpy as np

spec = importlib.util.spec_from_file_location("image_ratio_canvas", "src/server/python/image_ratio_canvas.py")
ratio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ratio)

image = np.full((600, 600, 3), 24, dtype=np.uint8)
converted = ratio.fit_to_canvas(image)
print(json.dumps({
    "shape": converted.shape[:2],
    "corner": converted[0, 0].tolist(),
    "center": converted[720, 540].tolist(),
}))
`;

  const result = spawnSync(process.env.PYTHON || "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.shape, [1440, 1080]);
  assert.deepEqual(payload.corner, [255, 255, 255]);
  assert.deepEqual(payload.center, [24, 24, 24]);
});
