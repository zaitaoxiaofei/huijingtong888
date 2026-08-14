import { getMysqlPoolMetrics } from "../mysql-pool.js";

const GLOBAL_CONCURRENCY_CAP = Math.max(1, Number(process.env.AI_IMAGE_GLOBAL_CONCURRENCY_CAP || 12));
const state = {
  activeTotal: 0,
  activeByChannel: new Map(),
  waiters: []
};

export function adaptiveAiImageConcurrency(requested = GLOBAL_CONCURRENCY_CAP) {
  const memory = process.memoryUsage();
  const rssMb = memory.rss / 1024 / 1024;
  const heapMb = memory.heapUsed / 1024 / 1024;
  const externalMb = (memory.external + memory.arrayBuffers) / 1024 / 1024;
  const pool = getMysqlPoolMetrics();
  let limit = Math.max(1, Math.min(GLOBAL_CONCURRENCY_CAP, Number(requested || 1)));
  if (rssMb >= 1400 || heapMb >= 900 || externalMb >= 900) limit = Math.min(limit, 1);
  else if (rssMb >= 1100 || heapMb >= 700 || externalMb >= 650) limit = Math.min(limit, 2);
  else if (rssMb >= 850 || heapMb >= 520 || externalMb >= 450) limit = Math.min(limit, 4);
  else if (rssMb >= 650 || heapMb >= 400 || externalMb >= 320) limit = Math.min(limit, 6);
  if (pool.activeConnections >= pool.connectionLimit - 1) limit = Math.min(limit, 1);
  else if (pool.activeConnections >= pool.connectionLimit - 3) limit = Math.min(limit, 3);
  return Math.max(1, limit);
}

export async function withAiImageRuntimeSlot(channel = {}, operation) {
  const release = await acquireAiImageRuntimeSlot(channel);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function aiImageRuntimeMetrics() {
  const memory = process.memoryUsage();
  return {
    activeTotal: state.activeTotal,
    waitingTotal: state.waiters.length,
    activeByChannel: Object.fromEntries(state.activeByChannel),
    adaptiveConcurrency: adaptiveAiImageConcurrency(GLOBAL_CONCURRENCY_CAP),
    globalConcurrencyCap: GLOBAL_CONCURRENCY_CAP,
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    externalMb: Math.round((memory.external + memory.arrayBuffers) / 1024 / 1024)
  };
}

function acquireAiImageRuntimeSlot(channel = {}) {
  return new Promise((resolve) => {
    state.waiters.push({
      channelKey: String(channel.channelId || channel.provider || channel.baseUrl || "default-image-channel"),
      channelLimit: Math.max(1, Number(channel.maxConcurrency || channel.poolMaxConcurrency || GLOBAL_CONCURRENCY_CAP)),
      poolLimit: Math.max(1, Number(channel.poolMaxConcurrency || channel.maxConcurrency || GLOBAL_CONCURRENCY_CAP)),
      resolve
    });
    drainWaiters();
  });
}

function drainWaiters() {
  let started = true;
  while (started) {
    started = false;
    for (let index = 0; index < state.waiters.length; index += 1) {
      const waiter = state.waiters[index];
      const channelActive = state.activeByChannel.get(waiter.channelKey) || 0;
      const adaptivePoolLimit = adaptiveAiImageConcurrency(waiter.poolLimit);
      if (state.activeTotal >= adaptivePoolLimit || channelActive >= waiter.channelLimit) continue;
      state.waiters.splice(index, 1);
      state.activeTotal += 1;
      state.activeByChannel.set(waiter.channelKey, channelActive + 1);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        state.activeTotal = Math.max(0, state.activeTotal - 1);
        const nextChannelActive = Math.max(0, (state.activeByChannel.get(waiter.channelKey) || 1) - 1);
        if (nextChannelActive) state.activeByChannel.set(waiter.channelKey, nextChannelActive);
        else state.activeByChannel.delete(waiter.channelKey);
        drainWaiters();
      });
      started = true;
      break;
    }
  }
}

