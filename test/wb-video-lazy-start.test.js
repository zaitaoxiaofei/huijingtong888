import assert from "node:assert/strict";
import test from "node:test";
import { createWbVideoPlayer } from "../frontend/admin/utils/wb-video-player.js";

class Video extends EventTarget {
  paused = true;
  src = "";
  pause() { this.paused = true; }
  removeAttribute() { this.src = ""; }
  load() {}
  canPlayType() { return ""; }
  userPlay() { this.paused = false; this.dispatchEvent(new Event("play")); }
}
class Hls {
  static Events = { ERROR: "error" };
  static isSupported() { return true; }
  constructor(options) { this.options = options; this.starts = []; }
  on() {}
  loadSource(url) { this.url = url; }
  attachMedia(video) { this.video = video; }
  startLoad(position) { this.starts.push(position); }
  destroy() { this.destroyed = true; }
}

test("the actual lazy controller starts on a native play Event and ignores an old media element after source replacement", async () => {
  const instances = [];
  class Recorded extends Hls { constructor(options) { super(options); instances.push(this); } }
  const controller = createWbVideoPlayer({ loadHls: async () => ({ default: Recorded }) });
  const first = new Video(); await controller.setSource(first, "https://media.fixture/first.m3u8");
  assert.equal(instances[0].options.autoStartLoad, false); assert.deepEqual(instances[0].starts, []);
  first.userPlay(); assert.deepEqual(instances[0].starts, [-1]);
  const next = new Video(); await controller.setSource(next, "https://media.fixture/second.m3u8");
  first.userPlay(); assert.equal(instances[0].destroyed, true); assert.deepEqual(instances[1].starts, []);
  next.userPlay(); assert.deepEqual(instances[1].starts, [-1]);
  controller.stop(); next.userPlay(); assert.deepEqual(instances[1].starts, [-1]);
});

test("a play gesture during the lazy import is remembered once HLS attaches", async () => {
  let finish, instance;
  class Recorded extends Hls { constructor(options) { super(options); instance = this; } }
  const controller = createWbVideoPlayer({ loadHls: () => new Promise(resolve => { finish = () => resolve({ default: Recorded }); }) });
  const video = new Video(), pending = controller.setSource(video, "https://media.fixture/delayed.m3u8");
  video.userPlay(); finish(); await pending;
  assert.deepEqual(instance.starts, [-1]); controller.stop();
});
