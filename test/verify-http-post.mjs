// Verify http_post inject path (Node) + capabilities probe.
// Run: node test/verify-http-post.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  actorHostImports,
  hostCaps,
  httpPostCapabilities,
  inMemoryStore,
} from '../src/actor-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = false;
function check(cond, msg) {
  if (!cond) {
    failed = true;
    console.error('FAIL:', msg);
  } else {
    console.log('OK:', msg);
  }
}

const capsProbe = httpPostCapabilities();
check(capsProbe.inject === true, 'inject path always advertised');
check(typeof capsProbe.recommended === 'string', `recommended=${capsProbe.recommended}`);
console.log('capabilities:', JSON.stringify(capsProbe));

// Mock sync POST: echo body prefixed
const httpPost = (url, body) => {
  const prefix = new TextEncoder().encode(`ECHO:${url}:`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
};

const memoryBox = {};
const caps = hostCaps({
  grants: ['http-post'],
  limits: { maxHttpPosts: 4 },
});
const imports = {
  kotoba: actorHostImports(['http-post'], caps, memoryBox, {
    store: inMemoryStore(),
    httpPost,
  }),
};
check(typeof imports.kotoba.http_post === 'function', 'http_post wired when inject present');

const wasmPath = path.join(here, '..', 'examples', 'http-post-echo.wasm');
const bytes = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, imports);
memoryBox.memory = instance.exports.memory;

const n = Number(instance.exports.main());
check(n > 0, `main wrote ${n} response bytes`);
const text = new TextDecoder().decode(new Uint8Array(memoryBox.memory.buffer, 64, n));
check(text.startsWith('ECHO:http://example.test/echo:'), `response prefix ok (got ${text})`);
check(text.endsWith('ping'), `response body echo (got ${text})`);

// quota: maxHttpPosts=1 should deny second call with -1
const memoryBox2 = {};
const caps2 = hostCaps({ grants: ['http-post'], limits: { maxHttpPosts: 1 } });
const imports2 = {
  kotoba: actorHostImports(['http-post'], caps2, memoryBox2, { httpPost }),
};
const { instance: inst2 } = await WebAssembly.instantiate(bytes, imports2);
memoryBox2.memory = inst2.exports.memory;
const first = Number(inst2.exports.main());
const second = Number(inst2.exports.main());
check(first > 0, `first call ok (${first})`);
check(second === -1, `second call metered -1 (got ${second})`);

// without inject, http_post must be absent (link fail if guest needs it)
const bare = actorHostImports(['http-post'], caps, {}, {});
check(bare.http_post === undefined, 'http_post absent without inject/bridge');

if (failed) {
  console.error('verify-http-post FAILED');
  process.exit(1);
}
console.log('OK: http_post inject path + metering + capabilities');
