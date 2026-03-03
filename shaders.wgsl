// Physarum simulation — agent update compute shader

const PI: f32 = 3.1415926535897932384626433832795;
const MIN_DISTANCE: f32 = 5.0;

struct Actor {
  position:       vec2f,     // offset  0, size  8
  direction:      f32,       // offset  8, size  4
  speed:          f32,       // offset 12, size  4
  color:          vec4f,     // offset 16, size 16  (16-byte aligned)
  original_color: vec4f,     // offset 32, size 16
  age:            f32,       // offset 48, size  4
  life:           f32,       // offset 52, size  4
  random_val:     f32,       // offset 56, size  4
  flags:          u32,       // offset 60, size  4
  // total: 64 bytes per actor
}

struct Uniforms {
  actor_count:  u32,   // offset  0
  random_seed:  f32,   // offset  4
  width:        f32,   // offset  8
  height:       f32,   // offset 12
  // total: 16 bytes
}

struct ColonyUniforms {
  look_slices:              i32,   // offset  0
  look_radians:             f32,   // offset  4
  look_distance:            f32,   // offset  8
  direction_randomization:  f32,   // offset 12
  direction_momentum:       f32,   // offset 16
  max_speed:                f32,   // offset 20
  min_speed:                f32,   // offset 24
  always_spawn_from_parent: f32,   // offset 28
  spawn_random_offset:      f32,   // offset 32
  intensity:                f32,   // offset 36
  lock_to_hsv_angles:       i32,   // offset 40
  hsv_angle_offset:         f32,   // offset 44
  hsv_saturation_multiplier: f32,  // offset 48
  hsv_value_multiplier:     f32,   // offset 52
  // total: 56 bytes (padded to 16-byte multiple = 64 in uniform buffer)
}

@group(0) @binding(0) var<storage, read_write> actors: array<Actor>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;
@group(0) @binding(2) var<uniform> colony: ColonyUniforms;
@group(0) @binding(3) var pheromone: texture_2d<f32>;

// ---------- RNG (xorshift32) ----------

fn rand(state: ptr<function, u32>) -> f32 {
  *state ^= (*state << 13u);
  *state ^= (*state >> 17u);
  *state ^= (*state << 5u);
  return f32(*state) * (1.0 / 4294967295.0);
}

// ---------- HSV helpers ----------

fn rgb2hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.b, c.g, K.w, K.z), vec4f(c.g, c.b, K.x, K.y), step(c.b, c.g));
  let q = mix(vec4f(p.x, p.y, p.w, c.r), vec4f(c.r, p.y, p.z, p.x), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  let h = abs(q.z + (q.w - q.y) / (6.0 * d + e));
  return vec3f(h, d / (q.x + e), q.x);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

fn hsv_distance(a: vec3f, b: vec3f) -> f32 {
  let hd = min(abs(a.r - b.r), 1.0 - abs(a.r - b.r));
  let sd = a.g - b.g;
  let vd = a.b - b.b;
  return sqrt(hd * hd + sd * sd + vd * vd);
}

fn hsv_mix(rgb1: vec3f, rgb2: vec3f, d: f32) -> vec3f {
  let a = rgb2hsv(rgb1);
  let b = rgb2hsv(rgb2);
  var hsvmix: vec3f;
  if (abs(a.r - b.r) < 1.0 - abs(a.r - b.r)) {
    hsvmix.r = mix(a.r, b.r, d);
  } else {
    let raw = mix(1.0 + a.r, b.r, d);
    hsvmix.r = raw - floor(raw);
  }
  hsvmix.g = mix(a.g, b.g, d);
  hsvmix.b = mix(a.b, b.b, d);
  return hsv2rgb(hsvmix);
}

fn dominant_color(rgb: vec4f) -> vec4f {
  if (colony.lock_to_hsv_angles == 0) {
    return rgb;
  }
  var hsv = rgb2hsv(rgb.rgb);
  let angles_f = f32(colony.lock_to_hsv_angles);
  hsv.r = round(hsv.r * angles_f) / angles_f;
  hsv.r += colony.hsv_angle_offset;
  let hmod = hsv.r - floor(hsv.r);
  hsv.r = min(abs(hmod), 1.0 - abs(hmod));
  hsv.g = min(1.0, hsv.g * colony.hsv_saturation_multiplier);
  hsv.b = min(1.0, hsv.b * colony.hsv_value_multiplier);
  return vec4f(hsv2rgb(hsv), rgb.a);
}

// ---------- Pheromone sampling ----------

fn sample_pheromone(coord: vec2f) -> vec4f {
  let ix = clamp(i32(coord.x), 0, i32(uniforms.width) - 1);
  let iy = clamp(i32(coord.y), 0, i32(uniforms.height) - 1);
  return textureLoad(pheromone, vec2<i32>(ix, iy), 0);
}

// ---------- Main compute kernel ----------

@compute @workgroup_size(64)
fn compute_main(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= uniforms.actor_count) {
    return;
  }

  // Seed RNG from actor's stored random value
  var rng_state: u32 = u32(actors[id].random_val * 4294967295.0);
  if (rng_state == 0u) { rng_state = id + 1u; }

  // Move actor
  let x_velocity = actors[id].speed * cos(actors[id].direction);
  let y_velocity = actors[id].speed * sin(actors[id].direction);
  actors[id].position.x += x_velocity;
  actors[id].position.y += y_velocity;

  let x = actors[id].position.x;
  let y = actors[id].position.y;

  // Sample pheromone at current location
  let pheromone_at_loc = sample_pheromone(vec2f(x, y));

  // Death / respawn check — respawn on home ring (radius stored in flags)
  if (actors[id].age >= 0.0 &&
      (actors[id].age > actors[id].life ||
       x < 0.0 || y < 0.0 ||
       x > uniforms.width || y > uniforms.height)) {

    let home_radius = bitcast<f32>(actors[id].flags);
    let center = vec2f(uniforms.width * 0.5, uniforms.height * 0.5);

    // Respawn at same radius, new random angle on the ring
    let respawn_angle = rand(&rng_state) * PI * 2.0;
    actors[id].position.x = center.x + home_radius * cos(respawn_angle);
    actors[id].position.y = center.y + home_radius * sin(respawn_angle);

    // Direction: outward from ring with some randomization
    actors[id].direction = respawn_angle + (rand(&rng_state) - 0.5) * PI * 0.33;
    actors[id].age = 0.0;
    actors[id].speed = colony.min_speed;
  }

  // Sensory loop — find direction of closest-matching pheromone
  var new_dir = actors[id].direction;
  var min_dist = MIN_DISTANCE;
  let hsv_actor = rgb2hsv(actors[id].original_color.rgb);

  // Randomize whether we check left or right first each frame
  // to avoid a systematic turn-direction bias from tie-breaking
  let scan_right_first = rand(&rng_state) < 0.5;

  for (var i: i32 = 0; i < colony.look_slices; i++) {
    // Use (i+1)/(N+1) to skip the redundant d=0 (straight-ahead) check
    let base_d = (f32(i) + 1.0) / (f32(colony.look_slices) + 1.0) * colony.look_radians;
    for (var j: i32 = 0; j < 2; j++) {
      var d = base_d;
      if ((scan_right_first && j == 0) || (!scan_right_first && j == 1)) {
        d = -d;
      }
      let t = actors[id].direction + d;
      let look_x = x + cos(t) * colony.look_distance;
      let look_y = y + sin(t) * colony.look_distance;
      let val = rgb2hsv(sample_pheromone(vec2f(look_x, look_y)).rgb);
      let dist = hsv_distance(val, hsv_actor);
      if (dist < min_dist) {
        new_dir = t;
        min_dist = dist;
      }
    }
  }

  // Update actor state
  actors[id].age += 1.0;

  // Direction with randomization and momentum (circular interpolation)
  new_dir += (rand(&rng_state) - 0.5) * colony.direction_randomization;
  let diff = new_dir - actors[id].direction;
  let wrapped_diff = diff - round(diff / (PI * 2.0)) * (PI * 2.0);
  let final_dir = actors[id].direction + wrapped_diff * (1.0 - colony.direction_momentum);
  actors[id].direction = final_dir - floor(final_dir / (PI * 2.0)) * (PI * 2.0);

  // Accelerate toward max speed
  actors[id].speed = min(colony.max_speed, actors[id].speed + rand(&rng_state) * 0.01);

  // Store RNG state for next frame
  actors[id].random_val = rand(&rng_state);

  // Blend color with pheromone
  actors[id].color = vec4f(
    hsv_mix(pheromone_at_loc.rgb, actors[id].color.rgb, colony.intensity),
    colony.intensity
  );
}

// ========== Render shaders ==========
// These use a separate bind group layout because vertex/fragment stages
// require read-only-storage (not read_write) for storage buffers.

// Note: These use @group(0) because the particle render pipeline has its own
// pipeline layout, independent from the compute pipeline layout.
@group(0) @binding(4) var<storage, read> agents_ro: array<Actor>;
@group(0) @binding(5) var<uniform> render_uniforms: Uniforms;

// ---------- Agent-to-pheromone pass ----------

struct ParticleVertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@vertex
fn vertex_particle(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32,
) -> ParticleVertexOut {
  let agent = agents_ro[instance_index];

  // 6 vertices forming a 1-pixel quad centered on agent position.
  // Centered offsets ensure the rasterized pixel matches the pixel
  // read by textureLoad(i32(pos)) in the compute shader.
  let quad_offsets = array<vec2f, 6>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(-0.5, 0.5),
    vec2f(0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5),
  );
  let offset = quad_offsets[vertex_index];
  let pixel_pos = agent.position + offset;

  // Convert pixel coords to NDC: pos / size * 2 - 1, flip Y
  var out: ParticleVertexOut;
  out.position = vec4f(
    pixel_pos.x / render_uniforms.width * 2.0 - 1.0,
    -(pixel_pos.y / render_uniforms.height * 2.0 - 1.0),
    0.0,
    1.0
  );
  out.color = agent.color;
  return out;
}

@fragment
fn fragment_particle(in: ParticleVertexOut) -> @location(0) vec4f {
  return in.color;
}

// ---------- Full-screen display pass ----------

struct FullscreenVertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertex_fullscreen(@builtin(vertex_index) vertex_index: u32) -> FullscreenVertexOut {
  // Full-screen triangle trick: 3 vertices, no vertex buffers needed
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var out: FullscreenVertexOut;
  out.position = vec4f(positions[vertex_index], 0.0, 1.0);
  out.uv = uvs[vertex_index];
  return out;
}

@group(0) @binding(6) var display_sampler: sampler;
@group(0) @binding(7) var display_texture: texture_2d<f32>;

@fragment
fn fragment_fullscreen(in: FullscreenVertexOut) -> @location(0) vec4f {
  return textureSample(display_texture, display_sampler, in.uv);
}

// ---------- Blur / fade post-processing pass ----------

struct BlurUniforms {
  blur_multiplier: f32,
  fade_decrement: f32,
  tex_width: f32,
  tex_height: f32,
}

@group(0) @binding(8) var blur_input: texture_2d<f32>;
@group(0) @binding(9) var<uniform> blur_params: BlurUniforms;

@vertex
fn vertex_blur(@builtin(vertex_index) vertex_index: u32) -> FullscreenVertexOut {
  // Same full-screen triangle trick as vertex_fullscreen
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var out: FullscreenVertexOut;
  out.position = vec4f(positions[vertex_index], 0.0, 1.0);
  out.uv = uvs[vertex_index];
  return out;
}

@fragment
fn fragment_blur(in: FullscreenVertexOut) -> @location(0) vec4f {
  let coord = vec2<i32>(in.position.xy);
  let max_coord = vec2<i32>(i32(blur_params.tex_width) - 1, i32(blur_params.tex_height) - 1);

  if (blur_params.blur_multiplier == 0.0) {
    let c = textureLoad(blur_input, coord, 0);
    return vec4f(max(vec3f(0.0), c.rgb - blur_params.fade_decrement), 1.0);
  }

  var total = vec4f(0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let sc = clamp(coord + vec2<i32>(i, j), vec2<i32>(0), max_coord);
      total += textureLoad(blur_input, sc, 0);
    }
  }
  total += textureLoad(blur_input, coord, 0) * blur_params.blur_multiplier;
  let avg = total / (blur_params.blur_multiplier + 9.0);
  return vec4f(max(vec3f(0.0), avg.rgb - blur_params.fade_decrement), 1.0);
}
