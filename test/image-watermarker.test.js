import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("shop watermark keeps crop size and blends transparent watermark pixels", () => {
  const script = String.raw`
import cv2
import importlib.util
import json
import numpy as np

spec = importlib.util.spec_from_file_location("image_watermarker", "src/server/python/image_watermarker.py")
watermarker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watermarker)

image = np.full((900, 1200, 3), 235, dtype=np.uint8)
watermark = np.zeros((120, 280, 4), dtype=np.uint8)
watermark[:, :, :3] = (18, 42, 218)
cv2.putText(watermark, "SHOP", (18, 82), cv2.FONT_HERSHEY_SIMPLEX, 2, (255, 255, 255, 255), 4, cv2.LINE_AA)
watermark[:, :, 3] = np.maximum(watermark[:, :, 3], 180)

color, alpha = watermarker.watermark_layers(watermark)
output = watermarker.apply_watermark(image, color, alpha)
top_left_output = watermarker.apply_watermark(image, color, alpha, position="top-left", width_ratio=0.3, opacity=0.5)
custom_output = watermarker.apply_watermark(image, color, alpha, position="custom", width_ratio=0.2, opacity=0.8, x_percent=50, y_percent=40)
changed = cv2.absdiff(output, image)
top_left_changed = cv2.absdiff(top_left_output, image)
custom_changed = cv2.absdiff(custom_output, image)

print(json.dumps({
    "shape": output.shape[:2],
    "changed_pixels": int(np.count_nonzero(cv2.cvtColor(changed, cv2.COLOR_BGR2GRAY))),
    "top_left_unchanged": bool(np.array_equal(output[:80, :80], image[:80, :80])),
    "custom_position_changes_top_left": int(np.count_nonzero(cv2.cvtColor(top_left_changed[:300, :500], cv2.COLOR_BGR2GRAY))),
    "custom_position_keeps_bottom_right": bool(np.array_equal(top_left_output[-80:, -80:], image[-80:, -80:])),
    "drag_position_changes_middle": int(np.count_nonzero(cv2.cvtColor(custom_changed[320:620, 520:900], cv2.COLOR_BGR2GRAY))),
    "drag_position_keeps_top_left": bool(np.array_equal(custom_output[:80, :80], image[:80, :80])),
}))
`;

  const result = spawnSync(process.env.PYTHON || "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout);
  assert.deepEqual(metrics.shape, [900, 1200]);
  assert.ok(metrics.changed_pixels > 1000);
  assert.equal(metrics.top_left_unchanged, true);
  assert.ok(metrics.custom_position_changes_top_left > 1000);
  assert.equal(metrics.custom_position_keeps_bottom_right, true);
  assert.ok(metrics.drag_position_changes_middle > 1000);
  assert.equal(metrics.drag_position_keeps_top_left, true);
});
