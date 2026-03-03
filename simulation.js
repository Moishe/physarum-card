// Pure simulation functions — shared between physarum.js and tests.
// No DOM or WebGPU dependencies.

export function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}

export function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function seedFromUserId(userId) {
  return Math.abs(djb2(userId));
}

export function docIdToHue(docId) {
  return (Math.abs(djb2(docId)) % 1000) / 1000;
}

export function hueToRgb(hue) {
  const h6 = hue * 6;
  const sector = Math.floor(h6) % 6;
  const f = h6 - Math.floor(h6);
  let r, g, b;
  switch (sector) {
    case 0: r = 1; g = f;     b = 0;     break;
    case 1: r = 1 - f; g = 1; b = 0;     break;
    case 2: r = 0; g = 1;     b = f;     break;
    case 3: r = 0; g = 1 - f; b = 1;     break;
    case 4: r = f; g = 0;     b = 1;     break;
    case 5: r = 1; g = 0;     b = 1 - f; break;
  }
  return { r, g, b };
}

export function groupEventsByHour(events) {
  if (events.length === 0) return [];
  const hourMap = new Map();
  for (const event of events) {
    const hourKey = event.created_at.slice(0, 13); // 'YYYY-MM-DDTHH'
    if (!hourMap.has(hourKey)) {
      hourMap.set(hourKey, []);
    }
    hourMap.get(hourKey).push(event);
  }
  const firstHour = new Date(events[0].created_at.slice(0, 13) + ':00:00Z');
  const lastHour = new Date(events[events.length - 1].created_at.slice(0, 13) + ':00:00Z');
  const buckets = [];
  const current = new Date(firstHour);
  while (current <= lastHour) {
    const hourKey = current.toISOString().slice(0, 13);
    buckets.push({
      date: hourKey,
      events: hourMap.get(hourKey) || [],
    });
    current.setTime(current.getTime() + 3600000); // +1 hour
  }
  return buckets;
}

// ---------- Constants ----------
export const SIM_SIZE = 1024;
export const MAX_AGENTS = 100000;
export const MAX_RADIUS = 350;
export const CENTER_X = SIM_SIZE / 2;
export const CENTER_Y = SIM_SIZE / 2;

export const ACTOR_STRIDE = 64;
export const ACTOR_FLOATS = ACTOR_STRIDE / 4;

export const OFF_POS_X = 0;
export const OFF_POS_Y = 1;
export const OFF_DIR = 2;
export const OFF_SPEED = 3;
export const OFF_COLOR = 4;
export const OFF_ORIG_COLOR = 8;
export const OFF_AGE = 12;
export const OFF_LIFE = 13;
export const OFF_RANDOM = 14;
export const OFF_FLAGS = 15;

export const SPAWN_COUNTS = {
  create: 100,
  edit: 20,
  view: 5,
  comment: 15,
  reaction: 3,
};

export const DIR_OFFSETS = {
  create: 0,
  edit: Math.PI / 8,
  view: Math.PI,
  comment: Math.PI / 2,
  reaction: null,
};
export const DIR_RANDOMIZATION = Math.PI / 6;

// ---------- Core spawn logic (no GPU dependency) ----------
// Populates cpuAgentData and agentHomeRadius arrays.
// Returns the new agent count.
export function spawnAgentsForEvents(rng, params, cpuAgentData, agentHomeRadius, currentAgentCount, events, currentDayIndex, totalDays) {
  const cpuU32 = new Uint32Array(cpuAgentData.buffer);
  const bitcastF32 = new Float32Array(1);
  const bitcastU32 = new Uint32Array(bitcastF32.buffer);

  let count = currentAgentCount;

  const radius = totalDays > 0
    ? (currentDayIndex / totalDays) * MAX_RADIUS
    : 0;

  for (const event of events) {
    const eventType = event.event_type || event.type || 'create';
    const spawnCount = SPAWN_COUNTS[eventType] || 5;
    const actualSpawn = Math.min(spawnCount, MAX_AGENTS - count);
    if (actualSpawn <= 0) break;

    let hue = docIdToHue(event.document_id);
    if (eventType === 'comment') {
      hue = (hue + 0.07) % 1.0;
    }
    const { r, g, b } = hueToRgb(hue);

    const rotationOffset = rng() * Math.PI * 2;

    bitcastF32[0] = radius;
    const radiusAsU32 = bitcastU32[0];

    for (let i = 0; i < actualSpawn; i++) {
      const base = count * ACTOR_FLOATS;

      const angle = (2 * Math.PI * i / actualSpawn) + rotationOffset;
      const jitterX = (rng() - 0.5) * 6;
      const jitterY = (rng() - 0.5) * 6;
      cpuAgentData[base + OFF_POS_X] = CENTER_X + radius * Math.cos(angle) + jitterX;
      cpuAgentData[base + OFF_POS_Y] = CENTER_Y + radius * Math.sin(angle) + jitterY;

      const dirOffset = DIR_OFFSETS[eventType];
      if (dirOffset === null) {
        cpuAgentData[base + OFF_DIR] = rng() * Math.PI * 2;
      } else {
        const randomization = (rng() - 0.5) * 2 * DIR_RANDOMIZATION;
        cpuAgentData[base + OFF_DIR] = angle + dirOffset + randomization;
      }

      cpuAgentData[base + OFF_SPEED] = params.minSpeed;
      cpuAgentData[base + OFF_COLOR + 0] = r;
      cpuAgentData[base + OFF_COLOR + 1] = g;
      cpuAgentData[base + OFF_COLOR + 2] = b;
      cpuAgentData[base + OFF_COLOR + 3] = 1.0;
      cpuAgentData[base + OFF_ORIG_COLOR + 0] = r;
      cpuAgentData[base + OFF_ORIG_COLOR + 1] = g;
      cpuAgentData[base + OFF_ORIG_COLOR + 2] = b;
      cpuAgentData[base + OFF_ORIG_COLOR + 3] = 1.0;
      cpuAgentData[base + OFF_AGE] = 0;
      cpuAgentData[base + OFF_LIFE] = 50000;
      cpuAgentData[base + OFF_RANDOM] = rng();
      cpuU32[base + OFF_FLAGS] = radiusAsU32;
      agentHomeRadius[count] = radius;

      count++;
    }
  }

  return count;
}
