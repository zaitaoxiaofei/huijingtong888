import argparse
import json
import math
import os
import sys

try:
    import cv2
    import numpy as np
except ImportError as exc:
    print(
        json.dumps({"error": "Python missing OpenCV dependencies. Install opencv-python and numpy."}),
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


def detect_regions(
    image,
    mode="auto",
    rows=0,
    cols=0,
    trim_border=2,
    background_color="auto",
    threshold=245,
    min_area_ratio=0.03,
    merge_distance=20,
    padding=4,
    round_corner_tolerance=True,
    manual_boxes=None,
):
    height, width = image.shape[:2]
    if mode == "manual":
        return normalize_manual_boxes(manual_boxes or [], width, height, padding)
    if mode == "grid":
        return grid_boxes(rows, cols, width, height, trim_border)
    if mode == "masonry":
        return detect_masonry_cards(
            image,
            background_color=background_color,
            threshold=threshold,
            min_area_ratio=min_area_ratio,
            merge_distance=merge_distance,
            padding=padding,
            round_corner_tolerance=round_corner_tolerance,
        )

    bounds = content_bounds(image)
    horizontal_lines, vertical_lines = detect_separator_lines(image, bounds)
    if mode == "horizontal":
        boxes = boxes_from_lines(bounds, horizontal_lines, [], width, height)
    elif mode == "vertical":
        boxes = boxes_from_lines(bounds, [], vertical_lines, width, height)
    else:
        collage_boxes = common_collage_layout_boxes(image, bounds)
        if len(collage_boxes) >= 2 and is_reliable_separator_partition(collage_boxes, width, height):
            return collage_boxes

        recursive_boxes = recursive_separator_boxes(image, bounds)
        if len(recursive_boxes) >= 2 and is_reliable_separator_partition(recursive_boxes, width, height):
            return recursive_boxes

        boxes = best_auto_boxes(bounds, horizontal_lines, vertical_lines, width, height)
        if len(boxes) >= 2 and is_reliable_separator_partition(boxes, width, height):
            return boxes
        masonry_boxes = detect_masonry_cards(
            image,
            background_color=background_color,
            threshold=threshold,
            min_area_ratio=min_area_ratio,
            merge_distance=merge_distance,
            padding=padding,
            round_corner_tolerance=round_corner_tolerance,
        )
        if len(masonry_boxes) >= 2:
            return masonry_boxes
        if len(boxes) >= 2:
            return boxes
        return []

    if len(boxes) >= 2:
        return boxes
    return []


def normalize_manual_boxes(boxes, image_width, image_height, padding):
    normalized = []
    for item in boxes:
        try:
            x = int(round(float(item.get("x", 0))))
            y = int(round(float(item.get("y", 0))))
            w = int(round(float(item.get("width", 0))))
            h = int(round(float(item.get("height", 0))))
        except Exception:
            continue
        if w <= 0 or h <= 0:
            continue
        left = max(0, x - padding)
        top = max(0, y - padding)
        right = min(image_width, x + w + padding)
        bottom = min(image_height, y + h + padding)
        if right > left and bottom > top:
            normalized.append((left, top, right - left, bottom - top))
    return sort_boxes_row_major(normalized)


def content_bounds(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    non_bg = gray < 248
    ys, xs = np.where(non_bg)
    if xs.size == 0 or ys.size == 0:
        height, width = gray.shape[:2]
        return (0, 0, width, height)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def detect_separator_lines(image, bounds):
    x0, y0, x1, y1 = bounds
    roi = image[y0:y1, x0:x1]
    height, width = roi.shape[:2]
    separator = build_separator_mask(roi)

    horizontal = long_line_mask(
        separator,
        open_kernel=(max(12, int(width * 0.12)), 1),
        close_kernel=(max(16, int(width * 0.08)), 1),
    )
    vertical = long_line_mask(
        separator,
        open_kernel=(1, max(12, int(height * 0.12))),
        close_kernel=(1, max(16, int(height * 0.08))),
    )

    horizontal_runs = merge_runs(find_axis_runs((horizontal > 0).mean(axis=1), 0.12, 1), max(2, int(height * 0.006)))
    vertical_runs = merge_runs(find_axis_runs((vertical > 0).mean(axis=0), 0.12, 1), max(2, int(width * 0.006)))
    if not horizontal_runs:
        horizontal_runs = merge_runs(find_axis_runs(separator.mean(axis=1) / 255, 0.22, 1), max(2, int(height * 0.006)))
    if not vertical_runs:
        vertical_runs = merge_runs(find_axis_runs(separator.mean(axis=0) / 255, 0.22, 1), max(2, int(width * 0.006)))
    horizontal_runs = remove_edge_runs(horizontal_runs, height)
    vertical_runs = remove_edge_runs(vertical_runs, width)
    if not horizontal_runs:
        horizontal_runs = projection_separator_runs(roi, "horizontal")
    if not vertical_runs:
        vertical_runs = projection_separator_runs(roi, "vertical")

    horizontal_lines = [(y0 + start, y0 + end) for start, end in horizontal_runs if is_inner_line(start, end, height)]
    vertical_lines = [(x0 + start, x0 + end) for start, end in vertical_runs if is_inner_line(start, end, width)]
    return horizontal_lines, vertical_lines


def build_separator_mask(image):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    bright = ((saturation <= 80) & (value >= 158)) | (gray >= 178) | np.all(image >= 160, axis=2)
    dark = (gray <= 32) & (np.median(gray) >= 120)
    mask = (bright | dark).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2)), iterations=1)
    return mask


def long_line_mask(mask, open_kernel, close_kernel):
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, open_kernel), iterations=1)
    closed = cv2.morphologyEx(opened, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, close_kernel), iterations=1)
    return closed


def find_axis_runs(values, threshold, min_run):
    runs = []
    start = None
    for index, value in enumerate(values):
        if value >= threshold and start is None:
            start = index
        elif value < threshold and start is not None:
            if index - start >= min_run:
                runs.append((start, index))
            start = None
    if start is not None and len(values) - start >= min_run:
        runs.append((start, len(values)))
    return runs


def merge_runs(runs, distance):
    if not runs:
        return []
    merged = [runs[0]]
    for start, end in runs[1:]:
        last_start, last_end = merged[-1]
        if start - last_end <= distance:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def remove_edge_runs(runs, length):
    edge_margin = max(8, int(length * 0.025))
    cleaned = []
    for start, end in runs:
        if start <= edge_margin and end >= length - edge_margin:
            continue
        if end <= edge_margin or start >= length - edge_margin:
            continue
        cleaned.append((start, end))
    return cleaned


def projection_separator_runs(image, orientation):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    values = gray.mean(axis=1) if orientation == "horizontal" else gray.mean(axis=0)
    length = len(values)
    median = float(np.median(values))
    p95 = float(np.percentile(values, 95))
    threshold = max(median + 35, min(p95, median + 90))
    runs = find_axis_runs(values / 255, threshold / 255, 1)
    runs = merge_runs(runs, max(2, int(length * 0.006)))
    return remove_edge_runs(runs, length)


def is_inner_line(start, end, length):
    center = (start + end) / 2
    margin = max(20, length * 0.08)
    return margin < center < length - margin


def best_auto_boxes(bounds, horizontal_lines, vertical_lines, width, height):
    candidate_specs = [
        ("horizontal", boxes_from_lines(bounds, horizontal_lines, [], width, height)),
        ("vertical", boxes_from_lines(bounds, [], vertical_lines, width, height)),
        ("grid", boxes_from_lines(bounds, horizontal_lines, vertical_lines, width, height)),
    ]
    candidate_specs = [(kind, boxes) for kind, boxes in candidate_specs if len(boxes) >= 2]
    if not candidate_specs:
        return []

    scores = {
        kind: boxes_score(boxes) + auto_structure_bonus(kind, boxes, horizontal_lines, vertical_lines)
        for kind, boxes in candidate_specs
    }

    best_kind, best_boxes = max(candidate_specs, key=lambda item: scores[item[0]])

    if "grid" in scores and len(candidate_specs) >= 2:
        grid_boxes = dict(candidate_specs)["grid"]
        if len(grid_boxes) >= 4:
            grid_score = scores["grid"]
            other_score = max(score for kind, score in scores.items() if kind != "grid")
            if grid_score >= other_score - 0.08:
                return sort_boxes_row_major(grid_boxes)

    return sort_boxes_row_major(best_boxes)


def auto_structure_bonus(kind, boxes, horizontal_lines, vertical_lines):
    if not boxes:
        return 0.0

    count = len(boxes)
    bonus = min(0.12, count * 0.015)

    if kind == "grid" and horizontal_lines and vertical_lines:
        bonus += 0.08
        if count >= 6:
            bonus += 0.04
        elif count >= 4:
            bonus += 0.02
    elif kind in {"horizontal", "vertical"} and (horizontal_lines or vertical_lines):
        bonus += 0.02

    return bonus


def boxes_from_lines(bounds, horizontal_lines, vertical_lines, image_width, image_height):
    x0, y0, x1, y1 = bounds
    x_segments = split_by_lines(x0, x1, vertical_lines)
    y_segments = split_by_lines(y0, y1, horizontal_lines)
    boxes = []
    padding = 1
    min_area = max(2500, int(image_width * image_height * 0.012))
    for top, bottom in y_segments:
        for left, right in x_segments:
            box = (
                max(0, left - padding),
                max(0, top - padding),
                min(image_width, right + padding) - max(0, left - padding),
                min(image_height, bottom + padding) - max(0, top - padding),
            )
            if box[2] * box[3] >= min_area:
                boxes.append(box)
    return sort_boxes_row_major(boxes)


def is_reliable_separator_partition(boxes, image_width, image_height):
    if len(boxes) < 2:
        return False

    image_area = max(1, image_width * image_height)
    area_coverage = sum(width * height for _, _, width, height in boxes) / image_area
    if area_coverage < 0.58:
        return False

    narrow_boxes = sum(1 for _, _, width, _ in boxes if width < image_width * 0.075)
    short_boxes = sum(1 for _, _, _, height in boxes if height < image_height * 0.075)
    return narrow_boxes <= max(1, len(boxes) // 3) and short_boxes <= max(1, len(boxes) // 3)


def split_by_lines(start, end, lines):
    segments = []
    cursor = start
    for line_start, line_end in sorted(lines):
        if line_start > cursor:
            segments.append((cursor, line_start))
        cursor = max(cursor, line_end)
    if cursor < end:
        segments.append((cursor, end))
    return [(a, b) for a, b in segments if b - a >= 12]


def recursive_separator_boxes(image, bounds):
    separator = build_separator_mask(image)
    boxes = split_rect_by_separator_mask(image, separator, bounds, depth=0)
    return sort_boxes_row_major(boxes)


def common_collage_layout_boxes(image, bounds):
    x0, y0, x1, y1 = bounds
    width = x1 - x0
    height = y1 - y0
    separator = build_separator_mask(image)

    root_horizontal = local_separator_candidates(image, separator, bounds, "horizontal")
    root_vertical = local_separator_candidates(image, separator, bounds, "vertical")
    bottom_split = choose_split_in_range(root_horizontal, y0 + height * 0.52, y0 + height * 0.82)
    main_vertical = choose_split_in_range(root_vertical, x0 + width * 0.42, x0 + width * 0.72)
    if not bottom_split or not main_vertical:
        return []

    _, bottom_start, bottom_end, _ = bottom_split
    _, main_start, main_end, _ = main_vertical
    right_rect = (main_end, y0, x1, bottom_start)
    right_horizontal = choose_split_in_range(
        local_separator_candidates(image, separator, right_rect, "horizontal"),
        y0 + (bottom_start - y0) * 0.28,
        y0 + (bottom_start - y0) * 0.72,
    )
    if not right_horizontal:
        return []

    _, right_start, right_end, _ = right_horizontal
    bottom_rect = (x0, bottom_end, x1, y1)
    bottom_verticals = local_separator_candidates(image, separator, bottom_rect, "vertical")
    bottom_verticals = [
        item for item in bottom_verticals
        if x0 + width * 0.18 <= ((item[1] + item[2]) / 2) <= x0 + width * 0.82
    ]
    bottom_verticals = sorted(bottom_verticals, key=lambda item: item[1])

    if len(bottom_verticals) >= 2 and bottom_verticals[0][1] <= main_start * 0.65:
        first_start, first_end = bottom_verticals[0][1], bottom_verticals[0][2]
        second_start, second_end = bottom_verticals[-1][1], bottom_verticals[-1][2]
    else:
        first_center = int(round((x0 + main_start) / 2))
        first_start = max(x0 + 1, first_center - 1)
        first_end = min(main_start - 1, first_center + 1)
        second_start, second_end = main_start, main_end

    rects = [
        (x0, y0, main_start, bottom_start),
        (main_end, y0, x1, right_start),
        (main_end, right_end, x1, bottom_start),
        (x0, bottom_end, first_start, y1),
        (first_end, bottom_end, second_start, y1),
        (second_end, bottom_end, x1, y1),
    ]
    return sort_boxes_row_major([box_from_rect(rect) for rect in rects if rect[2] - rect[0] >= 80 and rect[3] - rect[1] >= 80])


def choose_split_in_range(candidates, minimum, maximum):
    in_range = [
        item for item in candidates
        if minimum <= ((item[1] + item[2]) / 2) <= maximum
    ]
    if not in_range:
        return None
    return max(in_range, key=lambda item: item[3])


def split_rect_by_separator_mask(image, separator, rect, depth):
    x0, y0, x1, y1 = rect
    width = x1 - x0
    height = y1 - y0
    if depth >= 8 or width < 80 or height < 80:
        return [box_from_rect(rect)]

    split = best_local_separator_split(image, separator, rect)
    if not split:
        return [box_from_rect(rect)]

    orientation, start, end = split
    children = []
    if orientation == "horizontal":
        if start - y0 >= max(60, int(height * 0.14)):
            children.append((x0, y0, x1, start))
        if y1 - end >= max(60, int(height * 0.14)):
            children.append((x0, end, x1, y1))
    else:
        if start - x0 >= max(60, int(width * 0.14)):
            children.append((x0, y0, start, y1))
        if x1 - end >= max(60, int(width * 0.14)):
            children.append((end, y0, x1, y1))

    if len(children) < 2:
        return [box_from_rect(rect)]

    boxes = []
    for child in children:
        boxes.extend(split_rect_by_separator_mask(image, separator, child, depth + 1))
    return boxes


def best_local_separator_split(image, separator, rect):
    candidates = []
    candidates.extend(local_separator_candidates(image, separator, rect, "horizontal"))
    candidates.extend(local_separator_candidates(image, separator, rect, "vertical"))
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[3])[:3]


def local_separator_candidates(image, separator, rect, orientation):
    x0, y0, x1, y1 = rect
    roi = separator[y0:y1, x0:x1] > 0
    if roi.size == 0:
        return []

    height, width = roi.shape[:2]
    if orientation == "horizontal":
        values = np.mean(roi, axis=1)
        length = height
        span = width
        min_child = max(110, int(height * 0.25))
    else:
        values = np.mean(roi, axis=0)
        length = width
        span = height
        min_child = max(110, int(width * 0.25))

    coverage_threshold = 0.80
    runs = merge_runs(find_axis_runs(values, coverage_threshold, 1), max(2, int(length * 0.006)))
    candidates = []
    for start, end in runs:
        thickness = end - start
        center = (start + end) / 2
        if center < min_child or length - center < min_child:
            continue
        if thickness > max(42, int(length * 0.055)):
            continue
        local_score = float(values[start:end].mean()) if end > start else 0.0
        if local_score < coverage_threshold:
            continue
        split_start = (y0 + start) if orientation == "horizontal" else (x0 + start)
        split_end = (y0 + end) if orientation == "horizontal" else (x0 + end)
        balance = min(center, length - center) / max(center, length - center, 1)
        contrast = separator_neighbor_contrast(image, rect, orientation, int(split_start), int(split_end))
        score = local_score + min(0.18, balance * 0.18) + min(0.08, span / 2000) + min(0.32, contrast / 280)
        candidates.append((orientation, int(split_start), int(split_end), score))
    return candidates


def build_strict_separator_mask(image):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]
    mask = ((value >= 235) & (saturation <= 45)) | np.all(rgb >= 235, axis=2)
    mask = mask.astype(np.uint8) * 255
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2)), iterations=1)


def separator_neighbor_contrast(image, rect, orientation, start, end):
    x0, y0, x1, y1 = rect
    margin = 24
    gap = 6
    if orientation == "horizontal":
        before = image[max(y0, start - margin):max(y0, start - gap), x0:x1]
        after = image[min(y1, end + gap):min(y1, end + margin), x0:x1]
    else:
        before = image[y0:y1, max(x0, start - margin):max(x0, start - gap)]
        after = image[y0:y1, min(x1, end + gap):min(x1, end + margin)]

    if before.size == 0 or after.size == 0:
        return 0.0
    before_mean = before.reshape(-1, before.shape[-1]).mean(axis=0)
    after_mean = after.reshape(-1, after.shape[-1]).mean(axis=0)
    return float(np.linalg.norm(before_mean - after_mean))


def box_from_rect(rect):
    x0, y0, x1, y1 = rect
    return (int(x0), int(y0), int(x1 - x0), int(y1 - y0))


def grid_boxes(rows, cols, image_width, image_height, trim_border=2):
    rows = max(1, int(rows or 1))
    cols = max(1, int(cols or 1))
    trim = max(0, min(12, int(trim_border or 0)))
    boxes = []
    for row in range(rows):
        raw_top = round(image_height * row / rows)
        raw_bottom = round(image_height * (row + 1) / rows)
        for col in range(cols):
            raw_left = round(image_width * col / cols)
            raw_right = round(image_width * (col + 1) / cols)
            left = min(max(0, raw_left + trim), image_width)
            top = min(max(0, raw_top + trim), image_height)
            right = max(0, min(image_width, raw_right - trim))
            bottom = max(0, min(image_height, raw_bottom - trim))
            if right > left and bottom > top:
                boxes.append((left, top, right - left, bottom - top))
    return sort_boxes_row_major(boxes)


def detect_masonry_cards(
    image,
    background_color="auto",
    threshold=245,
    min_area_ratio=0.03,
    merge_distance=20,
    padding=4,
    round_corner_tolerance=True,
):
    threshold = int(max(200, min(254, threshold or 245)))
    merge_distance = max(0, int(merge_distance or 20))
    trim_border = max(0, int(padding or 0))
    min_area_ratio = max(0.01, float(min_area_ratio or 0.03))

    attempts = [
        (threshold, 0.92),
        (max(238, threshold - 4), 0.90),
        (245, 0.88),
    ]

    candidates = []
    seen = set()
    for attempt_threshold, gap_ratio in attempts:
        key = (attempt_threshold, gap_ratio)
        if key in seen:
            continue
        seen.add(key)
        boxes = white_gap_projection_split(
            image,
            background_color=background_color,
            threshold=attempt_threshold,
            gap_ratio=gap_ratio,
            min_gap_size=6,
            trim_border=trim_border,
            merge_distance=merge_distance,
            min_area_ratio=min_area_ratio,
        )
        if boxes:
            candidates.append(boxes)

    if not candidates:
        return []

    return max(candidates, key=projection_boxes_score)


def build_background_mask(image, background_color, threshold):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    if background_color == "white":
        mask = np.all(rgb >= threshold, axis=2)
    elif background_color == "light":
        mask = (hsv[:, :, 2] >= threshold - 10) & (hsv[:, :, 1] <= 55)
    else:
        mask = (hsv[:, :, 2] >= threshold - 5) & (hsv[:, :, 1] <= 65)
        mask |= np.all(rgb >= threshold, axis=2)

    return mask.astype(np.uint8) * 255


def white_gap_projection_split(
    image,
    background_color="auto",
    threshold=245,
    gap_ratio=0.92,
    min_gap_size=6,
    trim_border=3,
    merge_distance=20,
    min_area_ratio=0.03,
):
    height, width = image.shape[:2]
    image_area = width * height
    white_mask = (build_background_mask(image, background_color, threshold) > 0).astype(np.uint8)

    row_white_ratio = np.mean(white_mask, axis=1)
    horizontal_gap_indices = np.where(row_white_ratio > gap_ratio)[0].tolist()
    horizontal_gaps = merge_ranges(horizontal_gap_indices, min_gap_size=min_gap_size)

    row_blocks = blocks_from_gaps(height, horizontal_gaps, min_size=max(18, int(height * 0.12)))
    if not row_blocks:
        row_blocks = [(0, height)]

    row_entries = []
    for y1, y2 in row_blocks:
        row_entries.append({
            "start": y1,
            "end": y2,
            "rects": split_row_block_by_white_gaps(
                white_mask,
                y1,
                y2,
                width,
                height,
                image_area,
                gap_ratio,
                min_gap_size,
                trim_border,
                min_area_ratio,
            )
        })

    row_entries = merge_header_like_rows(
        row_entries,
        white_mask,
        width,
        height,
        image_area,
        gap_ratio,
        min_gap_size,
        trim_border,
        min_area_ratio,
    )
    row_entries = drop_top_banner_rows(row_entries, width, height)

    rectangles = []
    for entry in row_entries:
        rectangles.extend(entry["rects"])

    rectangles = split_projection_boxes_by_local_gaps(
        rectangles,
        white_mask,
        width,
        height,
        image_area,
        gap_ratio,
        min_gap_size,
        trim_border,
        min_area_ratio,
    )
    rectangles = sort_boxes_row_major(rectangles)
    if len(rectangles) > 1:
        rectangles = merge_projection_boxes(
            rectangles,
            merge_distance=max(merge_distance, int(min(width, height) * 0.01)),
            image_width=width,
            image_height=height,
            image_area=image_area,
            min_area_ratio=min_area_ratio,
        )
    return sort_boxes_row_major(rectangles)


def split_projection_boxes_by_local_gaps(
    rectangles,
    white_mask,
    image_width,
    image_height,
    image_area,
    gap_ratio,
    min_gap_size,
    trim_border,
    min_area_ratio,
):
    split_boxes = []
    for rectangle in rectangles:
        split_boxes.extend(split_projection_box_by_local_gaps(
            rectangle,
            white_mask,
            image_width,
            image_height,
            image_area,
            gap_ratio,
            min_gap_size,
            trim_border,
            min_area_ratio,
            depth=0,
        ))
    return sort_boxes_row_major(split_boxes)


def split_projection_box_by_local_gaps(
    rectangle,
    white_mask,
    image_width,
    image_height,
    image_area,
    gap_ratio,
    min_gap_size,
    trim_border,
    min_area_ratio,
    depth,
):
    if depth >= 3:
        return [rectangle]

    candidates = []
    for orientation in ("horizontal", "vertical"):
        child_boxes = local_gap_child_boxes(
            rectangle,
            white_mask,
            image_width,
            image_height,
            image_area,
            gap_ratio,
            min_gap_size,
            trim_border,
            min_area_ratio,
            orientation,
        )
        if len(child_boxes) >= 2:
            candidates.append(child_boxes)

    if not candidates:
        return [rectangle]

    best_children = max(candidates, key=local_split_score)
    split_boxes = []
    for child in best_children:
        split_boxes.extend(split_projection_box_by_local_gaps(
            child,
            white_mask,
            image_width,
            image_height,
            image_area,
            gap_ratio,
            min_gap_size,
            trim_border,
            min_area_ratio,
            depth + 1,
        ))
    return split_boxes


def local_gap_child_boxes(
    rectangle,
    white_mask,
    image_width,
    image_height,
    image_area,
    gap_ratio,
    min_gap_size,
    trim_border,
    min_area_ratio,
    orientation,
):
    x, y, width, height = rectangle
    local_mask = white_mask[y:y + height, x:x + width]
    if local_mask.size == 0:
        return []

    if orientation == "horizontal":
        gap_values = np.mean(local_mask, axis=1)
        blocks = blocks_from_gaps(height, merge_ranges(np.where(gap_values > gap_ratio)[0].tolist(), min_gap_size), max(18, int(height * 0.18)))
    else:
        gap_values = np.mean(local_mask, axis=0)
        blocks = blocks_from_gaps(width, merge_ranges(np.where(gap_values > gap_ratio)[0].tolist(), min_gap_size), max(16, int(width * 0.18)))

    if len(blocks) < 2:
        return []

    children = []
    for start, end in blocks:
        if orientation == "horizontal":
            x1, x2 = x, x + width
            y1, y2 = y + start, y + end
        else:
            x1, x2 = x + start, x + end
            y1, y2 = y, y + height

        tx1 = max(0, x1 + trim_border)
        ty1 = max(0, y1 + trim_border)
        tx2 = min(image_width, x2 - trim_border)
        ty2 = min(image_height, y2 - trim_border)
        if tx2 <= tx1 or ty2 <= ty1:
            continue
        if is_valid_projection_block(white_mask, tx1, ty1, tx2, ty2, image_width, image_height, image_area, min_area_ratio):
            children.append((int(tx1), int(ty1), int(tx2 - tx1), int(ty2 - ty1)))

    if len(children) < 2:
        return []

    child_area = sum(child[2] * child[3] for child in children)
    parent_area = max(1, width * height)
    return children if child_area / parent_area >= 0.42 else []


def local_split_score(boxes):
    areas = np.array([width * height for _, _, width, height in boxes], dtype=np.float64)
    return len(boxes) + float(areas.min() / max(areas.max(), 1))


def split_row_block_by_white_gaps(
    white_mask,
    y1,
    y2,
    image_width,
    image_height,
    image_area,
    gap_ratio,
    min_gap_size,
    trim_border,
    min_area_ratio,
):
    row_mask = white_mask[y1:y2, :]
    col_white_ratio = np.mean(row_mask, axis=0)
    vertical_gap_indices = np.where(col_white_ratio > gap_ratio)[0].tolist()
    vertical_gaps = merge_ranges(vertical_gap_indices, min_gap_size=min_gap_size)

    col_blocks = blocks_from_gaps(image_width, vertical_gaps, min_size=max(16, int(image_width * 0.10)))
    if not col_blocks:
        col_blocks = [(0, image_width)]

    rectangles = []
    for x1, x2 in col_blocks:
        tx1 = max(0, x1 + trim_border)
        ty1 = max(0, y1 + trim_border)
        tx2 = min(image_width, x2 - trim_border)
        ty2 = min(image_height, y2 - trim_border)
        if tx2 <= tx1 or ty2 <= ty1:
            continue
        if is_valid_projection_block(white_mask, tx1, ty1, tx2, ty2, image_width, image_height, image_area, min_area_ratio):
            rectangles.append((int(tx1), int(ty1), int(tx2 - tx1), int(ty2 - ty1)))
    return sort_boxes_row_major(rectangles)


def merge_header_like_rows(
    row_entries,
    white_mask,
    image_width,
    image_height,
    image_area,
    gap_ratio,
    min_gap_size,
    trim_border,
    min_area_ratio,
):
    if len(row_entries) <= 1:
        return row_entries

    merged = []
    index = 0
    while index < len(row_entries):
        current = row_entries[index]
        if index < len(row_entries) - 1 and should_merge_row_entries(current, row_entries[index + 1], image_width, image_height):
            combined = {
                "start": current["start"],
                "end": row_entries[index + 1]["end"],
            }
            combined["rects"] = split_row_block_by_white_gaps(
                white_mask,
                combined["start"],
                combined["end"],
                image_width,
                image_height,
                image_area,
                gap_ratio,
                min_gap_size,
                trim_border,
                min_area_ratio,
            )
            if len(combined["rects"]) >= len(row_entries[index + 1]["rects"]) and len(combined["rects"]) > 1:
                merged.append(combined)
                index += 2
                continue
        merged.append(current)
        index += 1
    return merged


def should_merge_row_entries(current, nxt, image_width, image_height):
    if len(current["rects"]) != 1 or len(nxt["rects"]) < 2:
        return False

    x, y, width, height = current["rects"][0]
    wide_strip = width >= image_width * 0.82
    short_strip = height <= image_height * 0.18
    top_strip = y <= image_height * 0.08
    return wide_strip and short_strip and top_strip


def drop_top_banner_rows(row_entries, image_width, image_height):
    if len(row_entries) < 2:
        return row_entries

    first = row_entries[0]
    second = row_entries[1]
    if len(first["rects"]) != 1 or len(second["rects"]) < 2:
        return row_entries

    x, y, width, height = first["rects"][0]
    wide_strip = width >= image_width * 0.82
    short_strip = height <= image_height * 0.18
    top_strip = y <= image_height * 0.08
    second_large = all(rect[3] >= image_height * 0.25 for rect in second["rects"][:2])

    if wide_strip and short_strip and top_strip and second_large:
        return row_entries[1:]
    return row_entries


def merge_ranges(indices, min_gap_size=6):
    if not indices:
        return []

    ranges = []
    start = indices[0]
    prev = indices[0]
    for index in indices[1:]:
        if index == prev + 1:
            prev = index
            continue
        if prev - start + 1 >= min_gap_size:
            ranges.append((start, prev))
        start = index
        prev = index

    if prev - start + 1 >= min_gap_size:
        ranges.append((start, prev))
    return ranges


def blocks_from_gaps(length, gaps, min_size):
    boundaries = [0]
    for start, end in gaps:
        boundaries.append((start + end) // 2)
    boundaries.append(length)
    boundaries = sorted(set(boundaries))

    blocks = []
    for index in range(len(boundaries) - 1):
        start = boundaries[index]
        end = boundaries[index + 1]
        if end - start >= min_size:
            blocks.append((start, end))
    return blocks


def is_valid_projection_block(white_mask, x1, y1, x2, y2, image_width, image_height, image_area, min_area_ratio):
    width = x2 - x1
    height = y2 - y1
    area = width * height
    if width < image_width * 0.12:
        return False
    if height < image_height * 0.12:
        return False
    if area < image_area * max(0.03, min_area_ratio):
        return False

    ratio = width / max(height, 1)
    if ratio < 0.25 or ratio > 4.0:
        return False

    block_mask = white_mask[y1:y2, x1:x2]
    white_ratio = float(np.mean(block_mask))
    non_white_ratio = 1.0 - white_ratio
    if non_white_ratio < 0.08:
        return False
    return True


def merge_projection_boxes(boxes, merge_distance, image_width, image_height, image_area, min_area_ratio):
    if len(boxes) <= 1:
        return boxes

    merged = [tuple(box) for box in boxes]
    min_area = image_area * max(0.03, min_area_ratio)
    changed = True
    while changed:
        changed = False
        next_boxes = []
        while merged:
            current = merged.pop(0)
            current_small = current[2] * current[3] < min_area * 1.35
            current_narrow = current[2] < image_width * 0.20
            current_short = current[3] < image_height * 0.20
            current_should_merge = current_small or current_narrow or current_short
            merged_this_round = False

            for index, other in enumerate(merged):
                if should_merge_projection_pair(current, other, merge_distance, current_should_merge):
                    current = union_box(current, other)
                    merged.pop(index)
                    merged.insert(0, current)
                    changed = True
                    merged_this_round = True
                    break

            if not merged_this_round:
                next_boxes.append(current)
        merged = next_boxes
    return merged


def should_merge_projection_pair(a, b, merge_distance, force_merge):
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh

    overlap_x = max(0, min(ax2, bx2) - max(ax1, bx1))
    overlap_y = max(0, min(ay2, by2) - max(ay1, by1))
    gap_x = max(0, max(ax1, bx1) - min(ax2, bx2))
    gap_y = max(0, max(ay1, by1) - min(ay2, by2))

    if overlap_x > 0 and overlap_y > 0:
        return True

    row_overlap = overlap_y / max(1, min(ah, bh))
    col_overlap = overlap_x / max(1, min(aw, bw))
    same_row = row_overlap >= 0.55 and gap_x <= merge_distance
    same_col = col_overlap >= 0.55 and gap_y <= merge_distance
    diagonal = gap_x <= merge_distance and gap_y <= merge_distance and (row_overlap > 0 or col_overlap > 0)
    return force_merge and (same_row or same_col or diagonal)


def projection_boxes_score(boxes):
    if not boxes:
        return 0
    count = len(boxes)
    count_score = 1.0 if 2 <= count <= 6 else max(0.0, 1.0 - abs(count - 5) * 0.2)
    areas = np.array([box[2] * box[3] for box in boxes], dtype=np.float64)
    area_balance = float(areas.min() / max(areas.max(), 1))
    widths = np.array([box[2] for box in boxes], dtype=np.float64)
    heights = np.array([box[3] for box in boxes], dtype=np.float64)
    image_width = float(max(widths.max(), 1))
    image_height = float(max(heights.max(), 1))
    banner_penalty = 0.0
    for _, _, width, height in boxes:
        ratio = width / max(height, 1)
        if ratio > 4.0 and height < image_height * 0.4:
            banner_penalty += 0.35
        if width > image_width * 0.9 and height < image_height * 0.35:
            banner_penalty += 0.25
    return (count_score * 0.45 + area_balance * 0.55) - banner_penalty


def merge_boxes(boxes, merge_distance):
    merged = [tuple(box) for box in boxes]
    changed = True
    while changed:
        changed = False
        next_boxes = []
        while merged:
            current = merged.pop(0)
            current_changed = False
            for index, other in enumerate(merged):
                if should_merge_boxes(current, other, merge_distance):
                    current = union_box(current, other)
                    merged.pop(index)
                    merged.insert(0, current)
                    changed = True
                    current_changed = True
                    break
            if not current_changed:
                next_boxes.append(current)
        merged = next_boxes
    return merged


def should_merge_boxes(a, b, merge_distance):
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh

    overlap_x = max(0, min(ax2, bx2) - max(ax1, bx1))
    overlap_y = max(0, min(ay2, by2) - max(ay1, by1))
    gap_x = max(0, max(ax1, bx1) - min(ax2, bx2))
    gap_y = max(0, max(ay1, by1) - min(ay2, by2))

    if overlap_x > 0 and overlap_y > 0:
        return True

    vertical_overlap_ratio = overlap_y / max(1, min(ah, bh))
    horizontal_overlap_ratio = overlap_x / max(1, min(aw, bw))

    same_row = vertical_overlap_ratio >= 0.32 and gap_x <= merge_distance
    same_col = horizontal_overlap_ratio >= 0.32 and gap_y <= merge_distance
    close_diag = gap_x <= merge_distance and gap_y <= merge_distance and (vertical_overlap_ratio > 0 or horizontal_overlap_ratio > 0)
    return same_row or same_col or close_diag


def union_box(a, b):
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    left = min(ax1, bx1)
    top = min(ay1, by1)
    right = max(ax1 + aw, bx1 + bw)
    bottom = max(ay1 + ah, by1 + bh)
    return (left, top, right - left, bottom - top)


def sort_boxes_row_major(boxes):
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda item: (item[1], item[0]))
    heights = [box[3] for box in boxes]
    row_tolerance = max(12, int(np.median(heights) * 0.35))
    rows = []
    for box in boxes:
        placed = False
        box_center_y = box[1] + box[3] / 2
        for row in rows:
            row_center = row["center_y"]
            top_aligned = abs(box[1] - row["top_y"]) <= row_tolerance
            center_aligned = abs(box_center_y - row_center) <= row_tolerance
            if top_aligned or center_aligned:
                row["boxes"].append(box)
                row["center_y"] = float(np.mean([candidate[1] + candidate[3] / 2 for candidate in row["boxes"]]))
                row["top_y"] = min(candidate[1] for candidate in row["boxes"])
                placed = True
                break
        if not placed:
            rows.append({"center_y": box_center_y, "top_y": box[1], "boxes": [box]})

    ordered = []
    for row in sorted(rows, key=lambda item: item["top_y"]):
        ordered.extend(sorted(row["boxes"], key=lambda item: item[0]))
    return ordered


def boxes_score(boxes):
    areas = np.array([w * h for _, _, w, h in boxes], dtype=np.float64)
    area_balance = float(areas.min() / max(areas.max(), 1))
    count_score = min(len(boxes), 12) / 12
    return area_balance * 0.65 + count_score * 0.35


def detect_by_contours(image):
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 40, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(min(width, height) * 0.006)),) * 2)
    mask = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    boxes = []
    min_area = max(2500, int(width * height * 0.015))
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w * h >= min_area and w >= width * 0.08 and h >= height * 0.08 and not (w > width * 0.98 and h > height * 0.98):
            boxes.append((x, y, w, h))
    return sort_boxes_row_major(boxes)


def crop_regions(image, boxes, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    crops = []
    trimmed_boxes = trim_internal_separator_edges(image, boxes)
    for index, (x, y, w, h) in enumerate(trimmed_boxes, start=1):
        crop = image[y : y + h, x : x + w]
        filename = f"crop_{index:03d}.png"
        output_path = os.path.join(output_dir, filename)
        write_image(output_path, crop)
        crops.append({"id": f"crop-{index:03d}", "filename": filename, "x": int(x), "y": int(y), "width": int(w), "height": int(h)})
    return crops


def trim_internal_separator_edges(image, boxes, max_trim=4):
    height, width = image.shape[:2]
    separator = build_strict_separator_mask(image) > 0
    trimmed = []
    for x, y, w, h in boxes:
        left = x
        top = y
        right = x + w
        bottom = y + h

        if left > 0:
            left += count_separator_edge(separator[top:bottom, left:right], "left", max_trim)
        if right < width:
            right -= count_separator_edge(separator[top:bottom, left:right], "right", max_trim)
        if top > 0:
            top += count_separator_edge(separator[top:bottom, left:right], "top", max_trim)
        if bottom < height:
            bottom -= count_separator_edge(separator[top:bottom, left:right], "bottom", max_trim)

        if right - left >= 24 and bottom - top >= 24:
            trimmed.append((int(left), int(top), int(right - left), int(bottom - top)))
        else:
            trimmed.append((int(x), int(y), int(w), int(h)))
    return trimmed


def count_separator_edge(mask, edge, max_trim):
    if mask.size == 0:
        return 0
    limit = min(max_trim, mask.shape[1] if edge in {"left", "right"} else mask.shape[0])
    count = 0
    for offset in range(limit):
        if edge == "left":
            ratio = float(np.mean(mask[:, offset]))
        elif edge == "right":
            ratio = float(np.mean(mask[:, mask.shape[1] - 1 - offset]))
        elif edge == "top":
            ratio = float(np.mean(mask[offset, :]))
        else:
            ratio = float(np.mean(mask[mask.shape[0] - 1 - offset, :]))
        if ratio < 0.45:
            break
        count += 1
    return count


def read_image(file_path):
    data = np.fromfile(file_path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def write_image(file_path, image):
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError(f"Failed to write cropped image: {file_path}")
    encoded.tofile(file_path)


def parse_manual_boxes(raw):
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    return data if isinstance(data, list) else []


def main():
    parser = argparse.ArgumentParser(description="Split ecommerce collage images into modules.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--mode", default="auto", choices=["auto", "horizontal", "vertical", "grid", "masonry", "manual"])
    parser.add_argument("--rows", type=int, default=0)
    parser.add_argument("--cols", type=int, default=0)
    parser.add_argument("--trim-border", type=int, default=2)
    parser.add_argument("--background-color", default="auto", choices=["auto", "white", "light"])
    parser.add_argument("--threshold", type=int, default=245)
    parser.add_argument("--min-area-ratio", type=float, default=0.03)
    parser.add_argument("--merge-distance", type=int, default=20)
    parser.add_argument("--padding", type=int, default=4)
    parser.add_argument("--round-corner-tolerance", default="1")
    parser.add_argument("--manual-boxes", default="")
    args = parser.parse_args()

    image = read_image(args.input)
    if image is None:
        raise RuntimeError("Unable to read image. Check file format and path.")

    manual_boxes = parse_manual_boxes(args.manual_boxes)
    boxes = detect_regions(
        image,
        mode=args.mode,
        rows=args.rows,
        cols=args.cols,
        trim_border=args.trim_border,
        background_color=args.background_color,
        threshold=args.threshold,
        min_area_ratio=args.min_area_ratio,
        merge_distance=args.merge_distance,
        padding=args.padding,
        round_corner_tolerance=str(args.round_corner_tolerance).lower() not in ("0", "false", "off"),
        manual_boxes=manual_boxes,
    )
    crops = crop_regions(image, boxes, args.output)
    height, width = image.shape[:2]
    print(json.dumps({"taskId": args.task_id, "image": {"width": int(width), "height": int(height)}, "crops": crops}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
