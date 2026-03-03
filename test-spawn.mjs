// Tests for direction and position distribution in agent spawning.
// Run with: node test-spawn.mjs

import {
  mulberry32, seedFromUserId, docIdToHue, hueToRgb,
  spawnAgentsForEvents, groupEventsByHour,
  ACTOR_FLOATS, OFF_POS_X, OFF_POS_Y, OFF_DIR,
  MAX_AGENTS, MAX_RADIUS, CENTER_X, CENTER_Y,
  SPAWN_COUNTS, DIR_OFFSETS, DIR_RANDOMIZATION,
} from './simulation.js';
import { generateMockEvents } from './mock-data.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertApprox(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) <= tolerance) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message} (expected ~${expected}, got ${actual})`);
  }
}

// Helper: compute mean direction vector from agent data
function meanDirectionVector(cpuAgentData, startAgent, count) {
  let sumCos = 0;
  let sumSin = 0;
  for (let i = startAgent; i < startAgent + count; i++) {
    const dir = cpuAgentData[i * ACTOR_FLOATS + OFF_DIR];
    sumCos += Math.cos(dir);
    sumSin += Math.sin(dir);
  }
  return {
    x: sumCos / count,
    y: sumSin / count,
    magnitude: Math.sqrt((sumCos / count) ** 2 + (sumSin / count) ** 2),
    angle: Math.atan2(sumSin / count, sumCos / count),
  };
}

// Helper: compute mean position offset from center
function meanPositionOffset(cpuAgentData, startAgent, count) {
  let sumX = 0;
  let sumY = 0;
  for (let i = startAgent; i < startAgent + count; i++) {
    sumX += cpuAgentData[i * ACTOR_FLOATS + OFF_POS_X] - CENTER_X;
    sumY += cpuAgentData[i * ACTOR_FLOATS + OFF_POS_Y] - CENTER_Y;
  }
  return {
    x: sumX / count,
    y: sumY / count,
    magnitude: Math.sqrt((sumX / count) ** 2 + (sumY / count) ** 2),
  };
}

// Helper: compute mean radius from center
function meanRadius(cpuAgentData, startAgent, count) {
  let sum = 0;
  for (let i = startAgent; i < startAgent + count; i++) {
    const dx = cpuAgentData[i * ACTOR_FLOATS + OFF_POS_X] - CENTER_X;
    const dy = cpuAgentData[i * ACTOR_FLOATS + OFF_POS_Y] - CENTER_Y;
    sum += Math.sqrt(dx * dx + dy * dy);
  }
  return sum / count;
}

const defaultParams = {
  minSpeed: 0.5, maxSpeed: 2.0,
};

// ============================================================
console.log('\n=== Test 1: Single create event — direction uniformity ===');
{
  const rng = mulberry32(seedFromUserId('test-user-1'));
  const cpuAgentData = new Float32Array(MAX_AGENTS * ACTOR_FLOATS);
  const agentHomeRadius = new Float32Array(MAX_AGENTS);
  const events = [{ event_type: 'create', document_id: 'doc-1', created_at: '2025-09-01T10:00:00Z' }];

  const count = spawnAgentsForEvents(rng, defaultParams, cpuAgentData, agentHomeRadius, 0, events, 50, 180);

  assert(count === 100, `Expected 100 agents, got ${count}`);

  const mv = meanDirectionVector(cpuAgentData, 0, count);
  console.log(`  Mean direction vector: (${mv.x.toFixed(4)}, ${mv.y.toFixed(4)}), magnitude=${mv.magnitude.toFixed(4)}, angle=${(mv.angle * 180 / Math.PI).toFixed(1)}°`);
  assert(mv.magnitude < 0.15, `Direction bias magnitude ${mv.magnitude.toFixed(4)} should be < 0.15 (uniform distribution)`);
}

// ============================================================
console.log('\n=== Test 2: Single create event — position on correct ring ===');
{
  const rng = mulberry32(seedFromUserId('test-user-2'));
  const cpuAgentData = new Float32Array(MAX_AGENTS * ACTOR_FLOATS);
  const agentHomeRadius = new Float32Array(MAX_AGENTS);
  const events = [{ event_type: 'create', document_id: 'doc-1', created_at: '2025-09-01T10:00:00Z' }];

  const dayIndex = 90;
  const totalDays = 180;
  const expectedRadius = (dayIndex / totalDays) * MAX_RADIUS; // 175

  const count = spawnAgentsForEvents(rng, defaultParams, cpuAgentData, agentHomeRadius, 0, events, dayIndex, totalDays);

  const mr = meanRadius(cpuAgentData, 0, count);
  console.log(`  Expected radius: ${expectedRadius.toFixed(1)}, mean radius: ${mr.toFixed(1)}`);
  assertApprox(mr, expectedRadius, 5, 'Mean radius should be close to expected');

  const mp = meanPositionOffset(cpuAgentData, 0, count);
  console.log(`  Mean position offset: (${mp.x.toFixed(2)}, ${mp.y.toFixed(2)}), magnitude=${mp.magnitude.toFixed(2)}`);
  assert(mp.magnitude < 10, `Position bias ${mp.magnitude.toFixed(2)} should be < 10 (centered on canvas)`);
}

// ============================================================
console.log('\n=== Test 3: Direction vectors by event type ===');
{
  const dayIndex = 90;
  const totalDays = 180;

  for (const [eventType, expectedOffset] of Object.entries(DIR_OFFSETS)) {
    const rng = mulberry32(seedFromUserId(`test-${eventType}`));
    const cpuAgentData = new Float32Array(MAX_AGENTS * ACTOR_FLOATS);
    const agentHomeRadius = new Float32Array(MAX_AGENTS);
    const events = [{ event_type: eventType, document_id: 'doc-1', created_at: '2025-09-01T10:00:00Z' }];

    const count = spawnAgentsForEvents(rng, defaultParams, cpuAgentData, agentHomeRadius, 0, events, dayIndex, totalDays);
    const mv = meanDirectionVector(cpuAgentData, 0, count);
    const spawnCount = SPAWN_COUNTS[eventType];

    if (expectedOffset === null) {
      // Reaction: fully random direction, should be roughly uniform
      console.log(`  ${eventType} (${spawnCount} agents): magnitude=${mv.magnitude.toFixed(4)} (expect ~0 for random)`);
      assert(mv.magnitude < 0.5, `${eventType} should have low direction bias`);
    } else {
      // For directed events, mean vector should point in the offset direction
      // But with only a few agents (view=5, reaction=3), statistical noise is high
      console.log(`  ${eventType} (${spawnCount} agents): magnitude=${mv.magnitude.toFixed(4)}, angle=${(mv.angle * 180 / Math.PI).toFixed(1)}°`);
      // The mean should be near 0 for events with many agents (uniform ring distribution)
      if (spawnCount >= 15) {
        assert(mv.magnitude < 0.2, `${eventType} should have low direction bias (got ${mv.magnitude.toFixed(4)})`);
      }
    }
  }
}

// ============================================================
console.log('\n=== Test 4: Full mock data — aggregate direction bias ===');
{
  const rng = mulberry32(seedFromUserId('demo'));
  const cpuAgentData = new Float32Array(MAX_AGENTS * ACTOR_FLOATS);
  const agentHomeRadius = new Float32Array(MAX_AGENTS);

  const mockEvents = generateMockEvents();
  const dayBuckets = groupEventsByHour(mockEvents);
  let totalAgents = 0;

  for (let d = 0; d < dayBuckets.length; d++) {
    const bucket = dayBuckets[d];
    if (bucket.events.length > 0) {
      totalAgents = spawnAgentsForEvents(
        rng, defaultParams, cpuAgentData, agentHomeRadius,
        totalAgents, bucket.events, d + 1, dayBuckets.length
      );
    }
  }

  console.log(`  Total agents spawned: ${totalAgents}`);
  const mv = meanDirectionVector(cpuAgentData, 0, totalAgents);
  console.log(`  Mean direction vector: (${mv.x.toFixed(4)}, ${mv.y.toFixed(4)})`);
  console.log(`  Bias magnitude: ${mv.magnitude.toFixed(4)}, angle: ${(mv.angle * 180 / Math.PI).toFixed(1)}°`);
  assert(mv.magnitude < 0.1, `Aggregate direction bias ${mv.magnitude.toFixed(4)} should be < 0.1`);

  const mp = meanPositionOffset(cpuAgentData, 0, totalAgents);
  console.log(`  Mean position offset: (${mp.x.toFixed(2)}, ${mp.y.toFixed(2)}), magnitude=${mp.magnitude.toFixed(2)}`);
}

// ============================================================
console.log('\n=== Test 5: Multiple seeds — direction bias consistency ===');
{
  const biases = [];
  for (const userId of ['alice', 'bob', 'charlie', 'demo', 'test123', 'user-42']) {
    const rng = mulberry32(seedFromUserId(userId));
    const cpuAgentData = new Float32Array(MAX_AGENTS * ACTOR_FLOATS);
    const agentHomeRadius = new Float32Array(MAX_AGENTS);

    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push({ event_type: 'create', document_id: `doc-${i}`, created_at: `2025-09-${String(i + 1).padStart(2, '0')}T10:00:00Z` });
    }

    let totalAgents = 0;
    const buckets = groupEventsByHour(events);
    for (let d = 0; d < buckets.length; d++) {
      if (buckets[d].events.length > 0) {
        totalAgents = spawnAgentsForEvents(
          rng, defaultParams, cpuAgentData, agentHomeRadius,
          totalAgents, buckets[d].events, d + 1, buckets.length
        );
      }
    }

    const mv = meanDirectionVector(cpuAgentData, 0, totalAgents);
    biases.push({ userId, magnitude: mv.magnitude, angle: mv.angle * 180 / Math.PI });
    console.log(`  ${userId}: magnitude=${mv.magnitude.toFixed(4)}, angle=${(mv.angle * 180 / Math.PI).toFixed(1)}°`);
  }

  // Check that biases don't all point the same direction
  const angles = biases.map(b => b.angle);
  const angleRange = Math.max(...angles) - Math.min(...angles);
  console.log(`  Angle range across seeds: ${angleRange.toFixed(1)}°`);
  assert(angleRange > 90, `Bias angles should vary across seeds (range=${angleRange.toFixed(1)}°), not all point one direction`);
}

// ============================================================
console.log('\n=== Test 6: Per-agent direction vs position angle (outward check) ===');
{
  const rng = mulberry32(seedFromUserId('outward-test'));
  const cpuAgentData = new Float32Array(MAX_AGENTS * ACTOR_FLOATS);
  const agentHomeRadius = new Float32Array(MAX_AGENTS);
  const events = [{ event_type: 'create', document_id: 'doc-1', created_at: '2025-09-01T10:00:00Z' }];

  const count = spawnAgentsForEvents(rng, defaultParams, cpuAgentData, agentHomeRadius, 0, events, 90, 180);

  // For each create agent, direction should be ~= position angle (outward) ± DIR_RANDOMIZATION
  let maxDeviation = 0;
  let deviationSum = 0;
  for (let i = 0; i < count; i++) {
    const base = i * ACTOR_FLOATS;
    const dx = cpuAgentData[base + OFF_POS_X] - CENTER_X;
    const dy = cpuAgentData[base + OFF_POS_Y] - CENTER_Y;
    const posAngle = Math.atan2(dy, dx);
    const dir = cpuAgentData[base + OFF_DIR];

    // Compute shortest angular difference
    let diff = dir - posAngle;
    diff = diff - Math.round(diff / (2 * Math.PI)) * (2 * Math.PI);

    deviationSum += diff;
    maxDeviation = Math.max(maxDeviation, Math.abs(diff));
  }
  const meanDeviation = deviationSum / count;
  console.log(`  Mean direction deviation from outward: ${(meanDeviation * 180 / Math.PI).toFixed(2)}°`);
  console.log(`  Max deviation: ${(maxDeviation * 180 / Math.PI).toFixed(1)}°`);
  assertApprox(meanDeviation, 0, 0.1, 'Mean deviation from outward should be ~0');
  assert(maxDeviation < DIR_RANDOMIZATION + 0.1, `Max deviation should be within randomization range ± margin`);
}

// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
