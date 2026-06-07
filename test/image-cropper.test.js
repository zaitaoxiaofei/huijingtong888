import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("masonry splitting follows local gaps inside a column", () => {
  const script = String.raw`
import importlib.util
import json
import numpy as np

spec = importlib.util.spec_from_file_location("image_cropper", "src/server/python/image_cropper.py")
cropper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cropper)

image = np.full((1448, 1086, 3), 255, dtype=np.uint8)
panels = [
    (10, 10, 710, 950),
    (728, 10, 348, 468),
    (728, 489, 348, 471),
    (10, 970, 348, 468),
    (367, 970, 351, 468),
    (727, 970, 349, 468),
]

for index, (x, y, width, height) in enumerate(panels):
    image[y:y + height, x:x + width] = (90 + index * 8, 120 + index * 6, 150 + index * 4)
    image[y + 40:y + height - 40, x + 50:x + width - 50] = (35, 50, 65)

print(json.dumps({
    "masonry": cropper.detect_regions(image, mode="masonry"),
    "false_separator_reliable": cropper.is_reliable_separator_partition([
        (8, 10, 128, 1430),
        (135, 10, 17, 1430),
        (158, 10, 17, 1430),
        (197, 10, 87, 1430),
        (449, 10, 102, 1430),
        (777, 10, 16, 1430),
        (988, 10, 88, 1430),
    ], 1086, 1448),
}))
`;

  const result = spawnSync(process.env.PYTHON || "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const boxes = JSON.parse(result.stdout);
  assert.equal(boxes.masonry.length, 6);
  assert.equal(boxes.false_separator_reliable, false);
  assert.ok(boxes.masonry.some(([, y, width, height]) => y < 50 && width < 400 && height < 520));
  assert.ok(boxes.masonry.some(([, y, width, height]) => y > 450 && y < 600 && width < 400 && height < 520));
  assert.ok(boxes.masonry[0][2] > 600);
});

test("auto splitting handles asymmetric ecommerce collages with local separators", () => {
  const script = String.raw`
import importlib.util
import json
import numpy as np

spec = importlib.util.spec_from_file_location("image_cropper", "src/server/python/image_cropper.py")
cropper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cropper)

image = np.full((1536, 1024, 3), 42, dtype=np.uint8)
image[0:1056, 0:629] = (48, 58, 70)
image[0:501, 633:1024] = (232, 232, 232)
image[534:1056, 633:1024] = (210, 210, 210)
image[1087:1536, 0:313] = (220, 220, 220)
image[1087:1536, 315:629] = (215, 215, 215)
image[1087:1536, 633:1024] = (36, 36, 36)

image[:, 629:633] = 255
image[1056:1087, :] = 255
image[501:534, 633:1024] = 255
image[1087:1536, 600:633] = 255

image[170:490, 700:980] = (45, 45, 45)
image[545:940, 690:980] = (70, 70, 70)
image[1200:1460, 70:250] = (90, 90, 90)
image[1180:1450, 380:560] = (85, 85, 85)

# Bright copy-like bands inside panels should not become crop separators.
image[84:117, 633:1024] = 248
image[584:595, 633:1024] = 248
image[1087:1536, 471:479] = 248

print(json.dumps(cropper.detect_regions(image, mode="auto")))
`;

  const result = spawnSync(process.env.PYTHON || "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const boxes = JSON.parse(result.stdout);
  assert.equal(boxes.length, 6);
  assert.ok(boxes[0][0] === 0 && boxes[0][1] === 0 && boxes[0][2] >= 620 && boxes[0][3] >= 1040);
  assert.ok(boxes.some(([x, y, width, height]) => x >= 630 && y === 0 && width >= 380 && height >= 490));
  assert.ok(boxes.some(([x, y, width, height]) => x === 0 && y >= 1080 && width >= 300 && height >= 440));
});

test("auto splitting keeps two-over-three ecommerce collage panels separate", () => {
  const script = String.raw`
import importlib.util
import json
import numpy as np

spec = importlib.util.spec_from_file_location("image_cropper", "src/server/python/image_cropper.py")
cropper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cropper)

image = np.full((1448, 1086, 3), 16, dtype=np.uint8)
image[0:724, 0:570] = (28, 28, 30)
image[0:724, 572:1086] = (24, 24, 26)
image[725:1448, 0:361] = (30, 30, 32)
image[725:1448, 362:721] = (26, 26, 28)
image[725:1448, 722:1086] = (22, 22, 24)

image[724:725, :] = 255
image[0:724, 570:572] = 255
image[725:1448, 361:362] = 255
image[725:1448, 721:722] = 255

# Real-world separators can be interrupted by dark artwork and icons.
image[900:1025, 721:722] = 18
image[1280:1375, 361:362] = 18

# Bright copy-like details inside panels should not become crop separators.
image[80:120, 80:460] = 220
image[820:860, 420:640] = 210

print(json.dumps(cropper.detect_regions(image, mode="auto")))
`;

  const result = spawnSync(process.env.PYTHON || "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const boxes = JSON.parse(result.stdout);
  assert.equal(boxes.length, 5);
  assert.ok(boxes[0][0] === 0 && boxes[0][1] === 0 && boxes[0][2] >= 560 && boxes[0][3] >= 710);
  assert.ok(boxes[1][0] >= 570 && boxes[1][1] === 0 && boxes[1][2] >= 500 && boxes[1][3] >= 710);
  assert.ok(boxes[2][0] === 0 && boxes[2][1] >= 724 && boxes[2][2] >= 350);
  assert.ok(boxes[3][0] >= 360 && boxes[3][1] >= 724 && boxes[3][2] >= 350);
  assert.ok(boxes[4][0] >= 720 && boxes[4][1] >= 724 && boxes[4][2] >= 350);
});

test("auto splitting keeps clean two-by-two collage as four panels", () => {
  const script = String.raw`
import importlib.util
import json
import numpy as np

spec = importlib.util.spec_from_file_location("image_cropper", "src/server/python/image_cropper.py")
cropper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cropper)

image = np.full((1448, 1086, 3), 18, dtype=np.uint8)
image[0:762, 0:539] = (34, 34, 36)
image[0:762, 546:1086] = (42, 42, 44)
image[769:1448, 0:539] = (58, 58, 60)
image[769:1448, 546:1086] = (66, 66, 68)

image[:, 539:546] = 255
image[762:769, :] = 255

# Bright copy bands inside the bottom-right panel should not create extra splits.
image[1046:1071, 546:1086] = 238
image[1270:1357, 546:1086] = 238

print(json.dumps(cropper.detect_regions(image, mode="auto")))
`;

  const result = spawnSync(process.env.PYTHON || "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const boxes = JSON.parse(result.stdout);
  assert.equal(boxes.length, 4);
  assert.ok(boxes[0][0] === 0 && boxes[0][1] === 0 && boxes[0][2] >= 530 && boxes[0][3] >= 750);
  assert.ok(boxes[1][0] >= 540 && boxes[1][1] === 0 && boxes[1][2] >= 530 && boxes[1][3] >= 750);
  assert.ok(boxes[2][0] === 0 && boxes[2][1] >= 760 && boxes[2][2] >= 530 && boxes[2][3] >= 670);
  assert.ok(boxes[3][0] >= 540 && boxes[3][1] >= 760 && boxes[3][2] >= 530 && boxes[3][3] >= 670);
});

test("cropping trims small internal separator leftovers", () => {
  const script = String.raw`
import importlib.util
import json
import numpy as np

spec = importlib.util.spec_from_file_location("image_cropper", "src/server/python/image_cropper.py")
cropper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cropper)

image = np.full((120, 160, 3), 255, dtype=np.uint8)
image[:, :76] = (30, 30, 30)
image[:, 84:] = (70, 70, 70)
image[:, 76:84] = (255, 255, 255)

boxes = [(0, 0, 82, 120), (78, 0, 82, 120)]
print(json.dumps(cropper.trim_internal_separator_edges(image, boxes)))
`;

  const result = spawnSync(process.env.PYTHON || "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const boxes = JSON.parse(result.stdout);
  assert.deepEqual(boxes, [[0, 0, 78, 120], [82, 0, 78, 120]]);
});
