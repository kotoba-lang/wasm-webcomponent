// Browser-side port of kotoba-lang/kotoba's src/kotoba/kami_host.clj — the
// deterministic game-engine ECS host behind the kami-* host imports
// (kotoba-core-contracts "kami/engine", capability id 233, single
// (module "kotoba") ABI). NOT the same surface as kami-engine-host.js:
// that module targets kami-script-runtime-rs's 4-namespace
// `kami:engine/*@1.0.0` import shape for kami-clj-compiled guests; THIS
// one hosts `kotoba wasm emit` binaries on kotoba's own one-module ABI,
// the same family as kgraph.js / actor-host.js (hand-JS, no build step).
//
// Parity contract (verify-kami-survivors.mjs): the same semantics as the
// JVM/Chicory host, op for op — host-owned entity table (insertion order
// = ascending id, mirroring kotoba.kami-host's sorted-map), fixed-step
// Euler integration at 1/60s, tick counter advanced by the driver BEFORE
// each guest `main` call, host-owned input axes, and a SEEDED xorshift64
// random stream (BigInt 64-bit, bit-exact with the JVM's long math) — so
// the same compiled kami_survivors.wasm plays the same game here that
// kotoba's kami_game_test.clj pins on Chicory (12 ghosts at tick 240, 8
// after the tick-270 nova burst, 10 at tick 300, seed 7).

const MASK64 = (1n << 64n) - 1n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n; // seed-0 remap, same as the JVM host

function xorshift64(s) {
  s = (s ^ (s << 13n)) & MASK64;
  s = s ^ (s >> 7n); // s is kept unsigned-masked, so >> is a logical shift
  s = (s ^ (s << 17n)) & MASK64;
  return s;
}

export const DEFAULT_DT = 1 / 60;

export function createKamiEcs(seed = 7) {
  let tick = 0;
  let nextId = 0;
  const entities = new Map(); // id -> {tag, x, y, vx, vy}; insertion order = ascending id
  const axes = new Map();
  let rng = BigInt(seed) & MASK64;
  if (rng === 0n) rng = GOLDEN_GAMMA;

  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

  return {
    spawnEntity(tag) {
      const id = nextId++;
      entities.set(id, { tag, x: 0, y: 0, vx: 0, vy: 0 });
      return id;
    },
    despawnEntity(id) {
      return entities.delete(id) ? 0 : -1;
    },
    setPosition(id, x, y) {
      const e = entities.get(id);
      if (!e) return -1;
      e.x = x; e.y = y;
      return 0;
    },
    setVelocity(id, vx, vy) {
      const e = entities.get(id);
      if (!e) return -1;
      e.vx = vx; e.vy = vy;
      return 0;
    },
    getX(id) { return entities.get(id)?.x ?? 0; },
    getY(id) { return entities.get(id)?.y ?? 0; },
    countTagged(tag) {
      let n = 0;
      for (const e of entities.values()) if (e.tag === tag) n++;
      return n;
    },
    nearestTagged(tag, x, y, maxDist) {
      let bestId = -1;
      let bestD = null;
      for (const [id, e] of entities) {
        if (e.tag !== tag) continue;
        const d = dist(x, y, e.x, e.y);
        if (d <= maxDist && (bestD === null || d < bestD)) { bestId = id; bestD = d; }
      }
      return bestId;
    },
    moveTaggedToward(tag, x, y, speed) {
      let n = 0;
      for (const e of entities.values()) {
        if (e.tag !== tag) continue;
        const d = dist(x, y, e.x, e.y);
        if (d < 1e-9) { e.vx = 0; e.vy = 0; }
        else { e.vx = speed * ((x - e.x) / d); e.vy = speed * ((y - e.y) / d); }
        n++;
      }
      return n;
    },
    despawnWithin(tag, x, y, radius) {
      const hit = [];
      for (const [id, e] of entities) {
        if (e.tag === tag && dist(x, y, e.x, e.y) <= radius) hit.push(id);
      }
      for (const id of hit) entities.delete(id);
      return hit.length;
    },
    setAxis(name, v) { axes.set(name, v); },
    axis(name) { return axes.get(name) ?? 0; },
    tickN() { return tick; },
    randInt(n) {
      rng = xorshift64(rng);
      return Number(rng % BigInt(n)); // rng is unsigned-masked = Long/remainderUnsigned
    },
    // Advance one fixed step (integrate, then bump the tick counter). The
    // driver calls this BEFORE each guest `main` call, so the guest always
    // observes freshly-integrated positions and a tick counter starting
    // at 1 — the same ordering kotoba.kami-host/step! documents.
    step(dt = DEFAULT_DT) {
      for (const e of entities.values()) {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
      }
      tick++;
    },
    // Introspection for renderers/tests (not part of the wire ABI).
    entityCount() { return entities.size; },
    totalSpawned() { return nextId; },
    entries() { return Array.from(entities.entries()); },
  };
}

// The (module "kotoba") import object for a `kotoba wasm emit` binary that
// uses the kami-* ops. MEMORYBOX is the usual deferred-memory convention
// (kgraph.js / kotoba-wasm-element.js): the module exports its own memory,
// so set memoryBox.memory = instance.exports.memory after instantiation.
// f32 params/results need no bit-unpacking here — the WebAssembly JS API
// hands host functions real numbers and frounds f32 returns, landing on
// exactly the same f32 values the JVM host's floatToRawIntBits path does.
export function kamiHostImports(ecs, memoryBox) {
  const str = (ptr, len) =>
    new TextDecoder('utf-8').decode(new Uint8Array(memoryBox.memory.buffer, ptr, len));
  return {
    kami_tick_n: () => ecs.tickN(),
    kami_spawn: (ptr, len) => ecs.spawnEntity(str(ptr, len)),
    kami_despawn: (id) => ecs.despawnEntity(id),
    kami_set_position: (id, x, y) => ecs.setPosition(id, x, y),
    kami_set_velocity: (id, vx, vy) => ecs.setVelocity(id, vx, vy),
    kami_get_x: (id) => ecs.getX(id),
    kami_get_y: (id) => ecs.getY(id),
    kami_count_tagged: (ptr, len) => ecs.countTagged(str(ptr, len)),
    kami_nearest_tagged: (ptr, len, x, y, maxDist) => ecs.nearestTagged(str(ptr, len), x, y, maxDist),
    kami_move_tagged_toward: (ptr, len, x, y, speed) => ecs.moveTaggedToward(str(ptr, len), x, y, speed),
    kami_despawn_within: (ptr, len, x, y, radius) => ecs.despawnWithin(str(ptr, len), x, y, radius),
    kami_axis: (ptr, len) => ecs.axis(str(ptr, len)),
    kami_rand: (n) => ecs.randInt(n),
  };
}
