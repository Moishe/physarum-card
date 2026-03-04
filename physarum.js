import { generateMockEvents } from './mock-data.js';
import {
  mulberry32, seedFromUserId, groupEventsByHour,
  spawnAgentsForEvents,
  SIM_SIZE, MAX_AGENTS,
  ACTOR_STRIDE, ACTOR_FLOATS,
  OFF_LIFE,
} from './simulation.js';

// ---------- Epoch controller ----------
class EpochController {
  constructor(buckets, stepsPerEpoch) {
    this.buckets = buckets;
    this.stepsPerEpoch = stepsPerEpoch;
    this.currentIndex = 0;
    this.totalBuckets = buckets.length;
  }

  advance() {
    if (this.isComplete()) return null;
    const bucket = this.buckets[this.currentIndex];
    this.currentIndex++;
    return bucket;
  }

  isComplete() {
    return this.currentIndex >= this.totalBuckets;
  }

  progress() {
    return this.totalBuckets > 0 ? this.currentIndex / this.totalBuckets : 1;
  }
}

const canvas = document.getElementById('canvas');
const status = document.getElementById('status');

// ---------- Uniforms layout ----------
// Uniforms: 16 bytes
//   actor_count  u32  offset 0
//   random_seed  f32  offset 4
//   width        f32  offset 8
//   height       f32  offset 12
const UNIFORMS_SIZE = 16;

// ColonyUniforms: 56 bytes (padded to 64 for uniform buffer alignment)
//   look_slices               i32  offset  0
//   look_radians              f32  offset  4
//   look_distance             f32  offset  8
//   direction_randomization   f32  offset 12
//   direction_momentum        f32  offset 16
//   max_speed                 f32  offset 20
//   min_speed                 f32  offset 24
//   always_spawn_from_parent  f32  offset 28
//   spawn_random_offset       f32  offset 32
//   intensity                 f32  offset 36
//   lock_to_hsv_angles        i32  offset 40
//   hsv_angle_offset          f32  offset 44
//   hsv_saturation_multiplier f32  offset 48
//   hsv_value_multiplier      f32  offset 52
const COLONY_UNIFORMS_SIZE = 64; // padded to 16-byte multiple

// ---------- Mutable params (driven by UI sliders) ----------
const params = {
  lookSlices: 7,
  lookRadians: 1.05,
  lookDistance: 24,
  dirMomentum: 0.1,
  dirRandom: 0.3,
  maxSpeed: 0.08,
  minSpeed: 0.05,
  intensity: 0.01,
  hsvAngles: 7,
  hsvOffset: 0.05,
  fadeDec: 0.004,
  blurMult: 0,
  blurInterval: 4,
  spawnOffset: 0,
  density: 5,
  epochsPerSecond: 20,
  stepsPerEpoch: 1,
};

// Map slider IDs to params keys
const sliderMap = [
  { id: 'look-slices',   key: 'lookSlices',   integer: true },
  { id: 'look-radians',  key: 'lookRadians',  integer: false },
  { id: 'look-distance', key: 'lookDistance',  integer: false },
  { id: 'dir-momentum',  key: 'dirMomentum',  integer: false },
  { id: 'dir-random',    key: 'dirRandom',    integer: false },
  { id: 'max-speed',     key: 'maxSpeed',     integer: false },
  { id: 'min-speed',     key: 'minSpeed',     integer: false },
  { id: 'intensity',     key: 'intensity',    integer: false },
  { id: 'hsv-angles',    key: 'hsvAngles',    integer: true },
  { id: 'hsv-offset',    key: 'hsvOffset',    integer: false },
  { id: 'fade-dec',      key: 'fadeDec',      integer: false },
  { id: 'blur-mult',     key: 'blurMult',     integer: false },
  { id: 'blur-interval', key: 'blurInterval', integer: true },
  { id: 'spawn-offset',  key: 'spawnOffset',  integer: false },
  { id: 'density',       key: 'density',      integer: false },
];

// Wire sliders to params
for (const { id, key, integer } of sliderMap) {
  const slider = document.getElementById(id);
  const valSpan = document.getElementById(id + '-val');
  if (!slider) continue;
  slider.addEventListener('input', () => {
    const v = integer ? parseInt(slider.value, 10) : parseFloat(slider.value);
    params[key] = v;
    if (valSpan) valSpan.textContent = slider.value;
  });
}

// ---------- H key toggle for controls panel ----------
const controlsPanel = document.getElementById('controls');
document.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') {
    controlsPanel.classList.toggle('hidden');
  }
});

// ---------- FPS tracking ----------
let fpsFrameTimes = [];
let lastFrameTime = performance.now();
let displayedFps = 0;

// ---------- URL params ----------
const urlParams = new URLSearchParams(window.location.search);
const userId = urlParams.get('userId') || 'demo';
const dataSource = urlParams.get('data') || 'mock';

// ---------- Deterministic RNG from userId ----------
const rng = mulberry32(seedFromUserId(userId));

// ---------- Data loading ----------
async function fetchUserEvents(userId, baseUrl) {
  const tokenParam = urlParams.get('token') || '';
  const headers = {};
  if (tokenParam) {
    headers['Authorization'] = `Bearer ${tokenParam}`;
  }
  const response = await fetch(`${baseUrl}/api/users/${userId}/events`, { headers });
  if (!response.ok) throw new Error(`Failed to fetch events: ${response.status}`);
  return response.json();
}

async function loadEventsFromFile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load events from ${url}: ${response.status}`);
  return response.json();
}

async function loadEvents() {
  if (dataSource === 'api') {
    const baseUrl = urlParams.get('baseUrl') || 'http://localhost:8181';
    try {
      const events = await fetchUserEvents(userId, baseUrl);
      console.log(`Loaded ${events.length} events from API`);
      return events;
    } catch (err) {
      console.warn(`API fetch failed, falling back to mock data:`, err.message);
      return generateMockEvents();
    }
  }

  if (dataSource === 'json') {
    const url = urlParams.get('url');
    if (!url) {
      console.warn('data=json requires a url param, falling back to mock data');
      return generateMockEvents();
    }
    try {
      const events = await loadEventsFromFile(url);
      console.log(`Loaded ${events.length} events from ${url}`);
      return events;
    } catch (err) {
      console.warn(`JSON file load failed, falling back to mock data:`, err.message);
      return generateMockEvents();
    }
  }

  // Default: mock
  return generateMockEvents();
}

// ---------- Spawn agents and upload to GPU ----------
// Thin wrapper around spawnAgentsForEvents (from simulation.js) that also
// uploads the newly spawned agents to the GPU buffer.
function spawnAndUpload(device, agentBuffer, rng, cpuAgentData, agentHomeRadius, currentAgentCount, events, currentDayIndex, totalDays) {
  const prevCount = currentAgentCount;
  const newCount = spawnAgentsForEvents(
    rng, { minSpeed: params.minSpeed, maxSpeed: params.maxSpeed, density: params.density },
    cpuAgentData, agentHomeRadius,
    currentAgentCount, events, currentDayIndex, totalDays
  );

  // Upload only the newly spawned agents to the GPU
  const spawned = newCount - prevCount;
  if (spawned > 0) {
    const byteOffset = prevCount * ACTOR_STRIDE;
    const floatOffset = prevCount * ACTOR_FLOATS;
    const floatCount = spawned * ACTOR_FLOATS;
    device.queue.writeBuffer(
      agentBuffer,
      byteOffset,
      cpuAgentData.buffer,
      floatOffset * 4,
      floatCount * 4
    );
  }

  return newCount;
}

async function init() {
  if (!navigator.gpu) {
    status.textContent = 'WebGPU not supported. Use Chrome 113+ or Safari 18+.';
    return;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    status.textContent = 'No GPU adapter found.';
    return;
  }
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  status.textContent = 'Loading shaders...';

  // ---------- Load WGSL shader ----------
  const shaderCode = await fetch('shaders.wgsl').then(r => r.text());
  const shaderModule = device.createShaderModule({ code: shaderCode });

  // ---------- Create agent storage buffer ----------
  const agentBufferSize = MAX_AGENTS * ACTOR_STRIDE;
  const agentBuffer = device.createBuffer({
    size: agentBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // ---------- Create uniforms buffer ----------
  const uniformsBuffer = device.createBuffer({
    size: UNIFORMS_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ---------- Create colony uniforms buffer ----------
  const colonyUniformsBuffer = device.createBuffer({
    size: COLONY_UNIFORMS_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ---------- Create ping-pong pheromone textures ----------
  // Two textures alternate as read/write targets each frame.
  const pheromoneTextureUsage =
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;

  const pheromoneTextureA = device.createTexture({
    size: [SIM_SIZE, SIM_SIZE],
    format: 'rgba8unorm',
    usage: pheromoneTextureUsage,
  });
  const pheromoneViewA = pheromoneTextureA.createView();

  const pheromoneTextureB = device.createTexture({
    size: [SIM_SIZE, SIM_SIZE],
    format: 'rgba8unorm',
    usage: pheromoneTextureUsage,
  });
  const pheromoneViewB = pheromoneTextureB.createView();

  // Index 0 = textureA is current, index 1 = textureB is current
  let currentTextureIndex = 0;
  const pheromoneViews = [pheromoneViewA, pheromoneViewB];

  // ---------- Create compute pipeline ----------
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const computePipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: {
      module: shaderModule,
      entryPoint: 'compute_main',
    },
  });

  // Two compute bind groups: one per ping-pong texture
  const computeBindGroups = [
    device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: agentBuffer } },
        { binding: 1, resource: { buffer: uniformsBuffer } },
        { binding: 2, resource: { buffer: colonyUniformsBuffer } },
        { binding: 3, resource: pheromoneViewA },
      ],
    }),
    device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: agentBuffer } },
        { binding: 1, resource: { buffer: uniformsBuffer } },
        { binding: 2, resource: { buffer: colonyUniformsBuffer } },
        { binding: 3, resource: pheromoneViewB },
      ],
    }),
  ];

  // ---------- Create particle render pipeline ----------
  // Renders agents as 1-pixel quads onto the pheromone texture with additive blending.
  // Uses a separate bind group layout because vertex/fragment stages require
  // read-only-storage (not storage) for buffer access.
  const particleBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 4,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      },
    ],
  });

  const particlePipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [particleBindGroupLayout],
  });

  const particleRenderPipeline = device.createRenderPipeline({
    layout: particlePipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: 'vertex_particle',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragment_particle',
      targets: [
        {
          format: 'rgba8unorm',
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: {
      topology: 'triangle-list',
    },
  });

  const particleBindGroup = device.createBindGroup({
    layout: particleBindGroupLayout,
    entries: [
      { binding: 4, resource: { buffer: agentBuffer } },
      { binding: 5, resource: { buffer: uniformsBuffer } },
    ],
  });

  // ---------- Create display render pipeline ----------
  // Full-screen triangle that samples the pheromone texture and displays it on the canvas.
  const displayBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 7,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
    ],
  });

  const displayPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [displayBindGroupLayout],
  });

  const displayRenderPipeline = device.createRenderPipeline({
    layout: displayPipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: 'vertex_fullscreen',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragment_fullscreen',
      targets: [
        {
          format: format,
        },
      ],
    },
    primitive: {
      topology: 'triangle-list',
    },
  });

  const displaySampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });

  // Two display bind groups: one per ping-pong texture
  const displayBindGroups = [
    device.createBindGroup({
      layout: displayBindGroupLayout,
      entries: [
        { binding: 6, resource: displaySampler },
        { binding: 7, resource: pheromoneViewA },
      ],
    }),
    device.createBindGroup({
      layout: displayBindGroupLayout,
      entries: [
        { binding: 6, resource: displaySampler },
        { binding: 7, resource: pheromoneViewB },
      ],
    }),
  ];

  // ---------- Create blur uniforms buffer ----------
  const BLUR_UNIFORMS_SIZE = 16; // 4 floats: blur_multiplier, fade_decrement, tex_width, tex_height
  const blurUniformsBuffer = device.createBuffer({
    size: BLUR_UNIFORMS_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ---------- Create blur render pipeline ----------
  const blurBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 8,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 9,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  });

  const blurPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [blurBindGroupLayout],
  });

  const blurRenderPipeline = device.createRenderPipeline({
    layout: blurPipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: 'vertex_blur',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragment_blur',
      targets: [
        {
          format: 'rgba8unorm', // writes to pheromone texture
        },
      ],
    },
    primitive: {
      topology: 'triangle-list',
    },
  });

  // Two blur bind groups: read from A write to B, and vice versa
  const blurBindGroups = [
    // When currentTextureIndex=0: read from A, blur output goes to B
    device.createBindGroup({
      layout: blurBindGroupLayout,
      entries: [
        { binding: 8, resource: pheromoneViewA },
        { binding: 9, resource: { buffer: blurUniformsBuffer } },
      ],
    }),
    // When currentTextureIndex=1: read from B, blur output goes to A
    device.createBindGroup({
      layout: blurBindGroupLayout,
      entries: [
        { binding: 8, resource: pheromoneViewB },
        { binding: 9, resource: { buffer: blurUniformsBuffer } },
      ],
    }),
  ];

  // ---------- Dynamic agent tracking ----------
  // Start with 0 agents -- the colony grows from event-driven spawning
  let currentAgentCount = 0;
  // CPU-side copy of agent data for spawning
  const cpuAgentData = new Float32Array(MAX_AGENTS * ACTOR_FLOATS);
  // CPU-side home radius per agent (for ring-based respawn)
  const agentHomeRadius = new Float32Array(MAX_AGENTS);

  // ---------- Write uniforms ----------
  const uniformsData = new ArrayBuffer(UNIFORMS_SIZE);
  const uniformsU32 = new Uint32Array(uniformsData);
  const uniformsF32 = new Float32Array(uniformsData);
  uniformsU32[0] = currentAgentCount; // actor_count (starts at 0)
  uniformsF32[1] = rng();            // random_seed
  uniformsF32[2] = SIM_SIZE;          // width
  uniformsF32[3] = SIM_SIZE;          // height
  device.queue.writeBuffer(uniformsBuffer, 0, uniformsData);

  // ---------- Colony and blur uniform buffers (rewritten from params each frame) ----------
  const colonyData = new ArrayBuffer(COLONY_UNIFORMS_SIZE);
  const colonyI32 = new Int32Array(colonyData);
  const colonyF32 = new Float32Array(colonyData);

  const blurUniformsData_live = new Float32Array(4);

  function writeColonyUniforms() {
    colonyI32[0] = params.lookSlices;          // look_slices
    colonyF32[1] = params.lookRadians;         // look_radians
    colonyF32[2] = params.lookDistance;         // look_distance
    colonyF32[3] = params.dirRandom;           // direction_randomization
    colonyF32[4] = params.dirMomentum;         // direction_momentum
    colonyF32[5] = params.maxSpeed;            // max_speed
    colonyF32[6] = params.minSpeed;            // min_speed
    colonyF32[7] = 1.0;                        // always_spawn_from_parent
    colonyF32[8] = params.spawnOffset;         // spawn_random_offset
    colonyF32[9] = params.intensity;           // intensity
    colonyI32[10] = params.hsvAngles;          // lock_to_hsv_angles
    colonyF32[11] = params.hsvOffset;          // hsv_angle_offset
    colonyF32[12] = 1.0;                       // hsv_saturation_multiplier
    colonyF32[13] = 1.0;                       // hsv_value_multiplier
    device.queue.writeBuffer(colonyUniformsBuffer, 0, colonyData);
  }

  function writeBlurUniforms() {
    blurUniformsData_live[0] = params.blurMult;    // blur_multiplier
    blurUniformsData_live[1] = params.fadeDec;     // fade_decrement
    blurUniformsData_live[2] = SIM_SIZE;           // tex_width
    blurUniformsData_live[3] = SIM_SIZE;           // tex_height
    device.queue.writeBuffer(blurUniformsBuffer, 0, blurUniformsData_live);
  }

  // Initial write
  writeColonyUniforms();
  writeBlurUniforms();

  // ---------- Load events and initialize epoch controller ----------
  status.textContent = `Loading events (${dataSource})...`;
  const events = await loadEvents();
  const hourBuckets = groupEventsByHour(events);
  let epochController = new EpochController(hourBuckets, params.stepsPerEpoch);

  // Epoch pacing state
  let epochAccumulator = 0; // accumulates time (ms) toward the next epoch advance
  let stepsThisEpoch = 0;   // simulation steps run in the current epoch
  let currentBucket = null;  // the day bucket currently being processed
  let playbackComplete = false;
  let idleModeApplied = false; // true once we've set agents to long life for idle mode

  status.textContent = `Physarum [${userId}]: 0 agents | Epoch 0/${epochController.totalBuckets}`;

  // ---------- Reset button ----------
  const resetBtn = document.getElementById('btn-reset');
  let generation = 0;

  function resetSimulation() {
    // Reset agent count to 0 and zero out CPU-side data
    currentAgentCount = 0;
    cpuAgentData.fill(0);
    agentHomeRadius.fill(0);

    // Clear both pheromone textures by rendering a clear pass to each
    const encoder = device.createCommandEncoder();
    for (let i = 0; i < 2; i++) {
      const clearPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: pheromoneViews[i],
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            storeOp: 'store',
          },
        ],
      });
      clearPass.end();
    }
    device.queue.submit([encoder.finish()]);

    currentTextureIndex = 0;
    generation = 0;

    // Reset epoch controller
    epochController = new EpochController(hourBuckets, params.stepsPerEpoch);
    epochAccumulator = 0;
    stepsThisEpoch = 0;
    currentBucket = null;
    playbackComplete = false;
    idleModeApplied = false;
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', resetSimulation);
  }

  // ---------- Frame loop ----------
  let workgroupCount = 0; // recomputed each frame from currentAgentCount

  function frame() {
    generation++;

    // Track FPS
    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;
    fpsFrameTimes.push(dt);
    if (fpsFrameTimes.length > 60) fpsFrameTimes.shift();

    // ---------- Epoch pacing ----------
    // During playback, accumulate time and advance epochs at the configured rate.
    // Each epoch corresponds to one day bucket. Between epoch advances, we run
    // stepsPerEpoch simulation steps, then advance to the next day.
    if (!playbackComplete) {
      const msPerEpoch = 1000 / params.epochsPerSecond;
      epochAccumulator += dt;

      // Advance as many epochs as the accumulated time allows
      while (epochAccumulator >= msPerEpoch && !epochController.isComplete()) {
        currentBucket = epochController.advance();
        if (currentBucket && currentBucket.events.length > 0) {
          currentAgentCount = spawnAndUpload(
            device, agentBuffer, rng, cpuAgentData, agentHomeRadius,
            currentAgentCount, currentBucket.events,
            epochController.currentIndex, epochController.totalBuckets
          );
        }
        stepsThisEpoch = 0;
        epochAccumulator -= msPerEpoch;
      }

      if (epochController.isComplete()) {
        playbackComplete = true;
      }
    }

    // ---------- Idle mode ----------
    // When playback completes, set all agents to very long life so they persist,
    // and only run the compute pass every other frame for a gentler idle effect.
    if (playbackComplete && !idleModeApplied && currentAgentCount > 0) {
      idleModeApplied = true;
      // Write a large life value to every agent on the GPU via cpuAgentData
      for (let i = 0; i < currentAgentCount; i++) {
        cpuAgentData[i * ACTOR_FLOATS + OFF_LIFE] = 999999;
      }
      const byteSize = currentAgentCount * ACTOR_STRIDE;
      device.queue.writeBuffer(agentBuffer, 0, cpuAgentData.buffer, 0, byteSize);
    }

    // ---------- Update status display every 30 frames ----------
    if (generation % 30 === 0) {
      const avgDt = fpsFrameTimes.reduce((a, b) => a + b, 0) / fpsFrameTimes.length;
      displayedFps = Math.round(1000 / avgDt);

      if (!playbackComplete) {
        const epochNum = epochController.currentIndex;
        const totalEpochs = epochController.totalBuckets;
        status.textContent = `[${userId}] Epoch ${epochNum}/${totalEpochs} | ${currentAgentCount} agents | Gen ${generation} | ${displayedFps} FPS`;
      } else {
        status.textContent = `[${userId}] Idle | ${currentAgentCount} agents | Gen ${generation} | ${displayedFps} FPS`;
      }
    }

    // Update uniforms from params each frame
    writeColonyUniforms();
    writeBlurUniforms();

    // Update agent count and random seed each frame
    uniformsU32[0] = currentAgentCount;
    uniformsF32[1] = rng();
    device.queue.writeBuffer(uniformsBuffer, 0, uniformsData);

    // Recompute workgroup count from current agent count
    workgroupCount = Math.ceil(currentAgentCount / 64);

    // In idle mode, only run the compute pass every other frame for a gentler effect
    const skipCompute = playbackComplete && (generation % 2 === 0);

    const encoder = device.createCommandEncoder();

    // 1. Blur pass (every blurInterval frames): read from current texture, write to other
    if (generation % params.blurInterval === 0) {
      const readIndex = currentTextureIndex;
      const writeIndex = 1 - currentTextureIndex;

      const blurPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: pheromoneViews[writeIndex],
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            storeOp: 'store',
          },
        ],
      });
      blurPass.setPipeline(blurRenderPipeline);
      blurPass.setBindGroup(0, blurBindGroups[readIndex]);
      blurPass.draw(3); // full-screen triangle
      blurPass.end();

      // Swap: the write target now has the latest data
      currentTextureIndex = writeIndex;
    }

    // Only run compute and particle passes if there are agents
    if (currentAgentCount > 0 && !skipCompute) {
      // 2. Compute pass: agents read from current texture
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(computePipeline);
      computePass.setBindGroup(0, computeBindGroups[currentTextureIndex]);
      computePass.dispatchWorkgroups(workgroupCount);
      computePass.end();

      // 3. Particle render pass: draw agents onto current pheromone texture (additive blend)
      const particlePass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: pheromoneViews[currentTextureIndex],
            loadOp: 'load',    // preserve existing trails
            storeOp: 'store',
          },
        ],
      });
      particlePass.setPipeline(particleRenderPipeline);
      particlePass.setBindGroup(0, particleBindGroup);
      particlePass.draw(6, currentAgentCount); // 6 vertices per quad, instanced
      particlePass.end();
    }

    // 4. Display pass: sample current pheromone texture onto canvas
    const displayPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        },
      ],
    });
    displayPass.setPipeline(displayRenderPipeline);
    displayPass.setBindGroup(0, displayBindGroups[currentTextureIndex]);
    displayPass.draw(3); // full-screen triangle
    displayPass.end();

    device.queue.submit([encoder.finish()]);

    stepsThisEpoch++;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

init();
