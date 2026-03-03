// Mock event data generator for the physarum simulation.
// Produces ~6 months of synthetic document activity events.

const TOPICS = ['A', 'B', 'C', 'D', 'E'];
const EVENT_TYPES = ['create', 'edit', 'view', 'comment', 'reaction'];
const OWNER_USER = 'user-owner-1';
const READER_USERS = ['user-reader-1', 'user-reader-2', 'user-reader-3'];

// Deterministic pseudo-random number generator (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isoDate(date, hours, minutes) {
  const d = new Date(date);
  d.setUTCHours(hours || 0, minutes || 0, 0, 0);
  return d.toISOString();
}

function randomTimeOnDay(date, rng) {
  const hours = Math.floor(rng() * 14) + 8; // 8am - 10pm
  const minutes = Math.floor(rng() * 60);
  return isoDate(date, hours, minutes);
}

function pickRandom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

export function generateMockEvents() {
  const rng = mulberry32(42); // deterministic seed
  const events = [];
  const startDate = new Date('2025-09-01T00:00:00Z');

  // Track which documents exist so far
  const existingDocs = [];

  function emit(eventType, docId, userId, date) {
    events.push({
      event_type: eventType,
      document_id: docId,
      user_id: userId,
      created_at: randomTimeOnDay(date, rng),
    });
  }

  // --- Week 1 (days 0-6): 3 documents created on different topics ---
  const week1Docs = [
    'doc-topic-A-1',
    'doc-topic-B-1',
    'doc-topic-C-1',
  ];
  for (let i = 0; i < week1Docs.length; i++) {
    const day = i * 2; // space them out: day 0, 2, 4
    emit('create', week1Docs[i], OWNER_USER, addDays(startDate, day));
    existingDocs.push(week1Docs[i]);
  }

  // --- Weeks 2-4 (days 7-27): edits on those docs, some views from other users ---
  for (let day = 7; day <= 27; day++) {
    const date = addDays(startDate, day);
    // 1-3 events per day
    const eventCount = 1 + Math.floor(rng() * 3);
    for (let e = 0; e < eventCount; e++) {
      const doc = pickRandom(existingDocs, rng);
      if (rng() < 0.6) {
        // edit by owner
        emit('edit', doc, OWNER_USER, date);
      } else {
        // view by a reader
        emit('view', doc, pickRandom(READER_USERS, rng), date);
      }
    }
  }

  // --- Month 2 (days 28-58): burst of new documents (4-5), comments start ---
  const month2NewDocs = [
    'doc-topic-A-2',
    'doc-topic-D-1',
    'doc-topic-B-2',
    'doc-topic-E-1',
    'doc-topic-C-2',
  ];
  // Create new docs spread across the first two weeks of month 2
  for (let i = 0; i < month2NewDocs.length; i++) {
    const day = 28 + Math.floor(i * 3);
    emit('create', month2NewDocs[i], OWNER_USER, addDays(startDate, day));
    existingDocs.push(month2NewDocs[i]);
  }

  for (let day = 28; day <= 58; day++) {
    const date = addDays(startDate, day);
    // 2-5 events per day (busier period)
    const eventCount = 2 + Math.floor(rng() * 4);
    for (let e = 0; e < eventCount; e++) {
      const doc = pickRandom(existingDocs, rng);
      const roll = rng();
      if (roll < 0.35) {
        emit('edit', doc, OWNER_USER, date);
      } else if (roll < 0.6) {
        emit('view', doc, pickRandom(READER_USERS, rng), date);
      } else if (roll < 0.85) {
        emit('comment', doc, pickRandom(READER_USERS, rng), date);
      } else {
        emit('reaction', doc, pickRandom(READER_USERS, rng), date);
      }
    }
  }

  // --- Months 3-4 (days 59-119): steady activity ---
  for (let day = 59; day <= 119; day++) {
    const date = addDays(startDate, day);
    // 2-4 events per day
    const eventCount = 2 + Math.floor(rng() * 3);
    for (let e = 0; e < eventCount; e++) {
      const doc = pickRandom(existingDocs, rng);
      const roll = rng();
      if (roll < 0.3) {
        emit('edit', doc, OWNER_USER, date);
      } else if (roll < 0.55) {
        emit('view', doc, pickRandom(READER_USERS, rng), date);
      } else if (roll < 0.75) {
        emit('comment', doc, pickRandom(READER_USERS, rng), date);
      } else {
        emit('reaction', doc, pickRandom(READER_USERS, rng), date);
      }
    }
  }

  // --- Month 5 (days 120-149): quiet period ---
  for (let day = 120; day <= 149; day++) {
    const date = addDays(startDate, day);
    // Only 2-3 events per WEEK, so most days have 0
    if (rng() < 0.12) {
      const doc = pickRandom(existingDocs, rng);
      const roll = rng();
      if (roll < 0.5) {
        emit('view', doc, pickRandom(READER_USERS, rng), date);
      } else {
        emit('edit', doc, OWNER_USER, date);
      }
    }
  }

  // --- Month 6 (days 150-179): new burst of activity ---
  const month6NewDocs = [
    'doc-topic-A-3',
    'doc-topic-D-2',
    'doc-topic-E-2',
  ];
  // Create new docs
  for (let i = 0; i < month6NewDocs.length; i++) {
    const day = 150 + Math.floor(i * 4);
    emit('create', month6NewDocs[i], OWNER_USER, addDays(startDate, day));
    existingDocs.push(month6NewDocs[i]);
  }

  for (let day = 150; day <= 179; day++) {
    const date = addDays(startDate, day);
    // 3-6 events per day (very active)
    const eventCount = 3 + Math.floor(rng() * 4);
    for (let e = 0; e < eventCount; e++) {
      const doc = pickRandom(existingDocs, rng);
      const roll = rng();
      if (roll < 0.25) {
        emit('edit', doc, OWNER_USER, date);
      } else if (roll < 0.5) {
        emit('view', doc, pickRandom(READER_USERS, rng), date);
      } else if (roll < 0.75) {
        emit('comment', doc, pickRandom(READER_USERS, rng), date);
      } else {
        emit('reaction', doc, pickRandom(READER_USERS, rng), date);
      }
    }
  }

  // Sort all events by created_at ascending
  events.sort((a, b) => a.created_at.localeCompare(b.created_at));

  return events;
}
