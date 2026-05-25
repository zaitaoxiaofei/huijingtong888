import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("image enhancement upscales product crops without flattening edges", () => {
  const script = String.raw`
import cv2
import importlib.util
import json
import numpy as np

spec = importlib.util.spec_from_file_location("image_enhancer", "src/server/python/image_enhancer.py")
enhancer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enhancer)

height, width = 480, 360
gradient = np.linspace(222, 246, height, dtype=np.uint8)[:, None]
image = np.repeat(gradient, width, axis=1)
image = cv2.merge((image, image, image))
cv2.rectangle(image, (70, 120), (290, 388), (34, 40, 46), -1)
cv2.rectangle(image, (82, 132), (278, 376), (62, 68, 74), 3)
cv2.putText(image, "TENET", (92, 270), cv2.FONT_HERSHEY_SIMPLEX, 1.25, (238, 238, 238), 3, cv2.LINE_AA)

enhanced = enhancer.enhance_image(image)
reference = cv2.resize(image, (enhanced.shape[1], enhanced.shape[0]), interpolation=cv2.INTER_LANCZOS4)
reference_gray = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
enhanced_gray = cv2.cvtColor(enhanced, cv2.COLOR_BGR2GRAY)

print(json.dumps({
    "shape": enhanced.shape[:2],
    "reference_edge": float(cv2.Laplacian(reference_gray, cv2.CV_64F).var()),
    "enhanced_edge": float(cv2.Laplacian(enhanced_gray, cv2.CV_64F).var()),
    "enhanced_min": int(enhanced.min()),
    "enhanced_max": int(enhanced.max()),
}))
`;

  const result = spawnSync(process.env.PYTHON || "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout);
  assert.deepEqual(metrics.shape, [1440, 1080]);
  assert.ok(metrics.enhanced_edge > metrics.reference_edge);
  assert.ok(metrics.enhanced_min >= 0);
  assert.ok(metrics.enhanced_max <= 255);
});
