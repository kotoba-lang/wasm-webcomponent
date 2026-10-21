const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ENTRY = /^[A-Za-z0-9._~!$&'()+,;=@/-]+$/;
const ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$/;
const RUNTIME_KEYS = ['entry', 'local-state', 'operations', 'profile', 'schema', 'target', 'workers'];
const OPERATION_KEYS = ['capability', 'consent', 'data-categories', 'endpoint', 'operation', 'redirect-origins', 'service'];
export const CLIENT_INFERENCE_PROTOCOL = 'kotoba.inference.v1';
const INFERENCE_REQUEST_KEYS = Object.freeze({
  load: ['approvedOperations', 'history', 'modelId'],
  generate: ['prompt'],
  cancel: [],
  reset: [],
});

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validName(value) {
  return typeof value === 'string' && NAME.test(value);
}

function validEntry(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && ENTRY.test(value)
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('//')
    && !/(^|\/)\.{1,2}(\/|$)/.test(value);
}

function validOrigin(value) {
  return typeof value === 'string' && ORIGIN.test(value);
}

const ENDPOINT_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ENDPOINT_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@_-]+$/;
const ENDPOINT_PARAMETER = /^:[A-Za-z][A-Za-z0-9_]*$/;
const ENDPOINT_QUERY_PARAMETER = /^[A-Za-z0-9._~_-]{1,128}$/;
const WILDCARD_HTTPS_ORIGIN = /^https:\/\/\*\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validRedirectOrigin(value) {
  return validOrigin(value) || (typeof value === 'string' && WILDCARD_HTTPS_ORIGIN.test(value));
}

function redirectOriginAllows(declaredOrigin, actualOrigin) {
  if (declaredOrigin === actualOrigin) return true;
  if (typeof declaredOrigin !== 'string' || !WILDCARD_HTTPS_ORIGIN.test(declaredOrigin)) return false;
  try {
    const actual = new URL(actualOrigin);
    const suffix = declaredOrigin.slice('https://*.'.length);
    return actual.protocol === 'https:'
      && actual.port === ''
      && actual.hostname !== suffix
      && actual.hostname.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

function validEndpointPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/')
      || value.startsWith('//') || value.includes('?') || value.includes('#')
      || value.includes('\\') || value.includes('//')) return false;
  if (value === '/') return true;
  const segments = value.slice(1).split('/');
  return segments.every((segment) => segment.length > 0
    && segment !== '.' && segment !== '..'
    && (ENDPOINT_PARAMETER.test(segment) || ENDPOINT_SEGMENT.test(segment)));
}

function validEndpoint(value) {
  return (exactKeys(value, ['origin', 'method', 'path'])
      && validOrigin(value.origin)
      && typeof value.method === 'string'
      && ENDPOINT_METHODS.has(value.method)
      && validEndpointPath(value.path))
    || (exactKeys(value, ['origin', 'routes'])
      && validOrigin(value.origin)
      && Array.isArray(value.routes)
      && value.routes.length > 0
      && value.routes.length <= 128
      && value.routes.every(validEndpointRoute)
      && new Set(value.routes.map(canonical)).size === value.routes.length);
}

function validEndpointRoute(route) {
  const exactPath = exactKeys(route, ['method', 'path', 'query-params'])
    || exactKeys(route, ['method', 'path', 'query-params', 'query-values']);
  const prefixPath = exactKeys(route, ['method', 'path-prefix', 'query-params'])
    || exactKeys(route, ['method', 'path-prefix', 'query-params', 'query-values']);
  if (!exactPath && !prefixPath) return false;
  if (typeof route.method !== 'string' || !ENDPOINT_METHODS.has(route.method)) return false;
  if (exactPath && !validEndpointPath(route.path)) return false;
  if (prefixPath && !validEndpointPathPrefix(route['path-prefix'])) return false;
  return Array.isArray(route['query-params'])
    && route['query-params'].length <= 64
    && route['query-params'].every((parameter) => typeof parameter === 'string'
      && ENDPOINT_QUERY_PARAMETER.test(parameter))
    && new Set(route['query-params']).size === route['query-params'].length
    && (!Object.hasOwn(route, 'query-values') || (record(route['query-values'])
      && Object.entries(route['query-values']).every(([parameter, value]) => (
        ENDPOINT_QUERY_PARAMETER.test(parameter)
          && route['query-params'].includes(parameter)
          && typeof value === 'string'
          && value.length <= 512
      ))));
}

function validEndpointPathPrefix(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/')
      || value.startsWith('//') || !value.endsWith('/') || value.includes('?')
      || value.includes('#') || value.includes('\\') || value.includes('//')) return false;
  const segments = value.slice(1, -1).split('/');
  return segments.length > 0 && segments.every((segment) => segment.length > 0
    && segment !== '.' && segment !== '..' && ENDPOINT_SEGMENT.test(segment));
}

function endpointRequest(payload, endpointOrigin) {
  if (!record(payload) || !Object.hasOwn(payload, 'input')) return null;
  const input = payload.input;
  const init = record(payload.init) ? payload.init : {};
  const source = (typeof Request !== 'undefined' && input instanceof Request)
    ? input.url
    : (typeof URL !== 'undefined' && input instanceof URL)
      ? input.href
      : input;
  if (typeof source !== 'string') return null;
  try {
    const url = new URL(source, endpointOrigin);
    const method = String(init.method
      ?? ((typeof Request !== 'undefined' && input instanceof Request) ? input.method : 'GET'))
      .toUpperCase();
    return {
      origin: url.origin,
      path: url.pathname,
      method,
      search: url.search,
      queryParameters: [...new Set(url.searchParams.keys())],
      searchParams: url.searchParams,
      hash: url.hash,
      hasCredentials: Boolean(url.username || url.password),
    };
  } catch {
    return null;
  }
}

function endpointPathMatches(pattern, path) {
  if (!validEndpointPath(pattern) || typeof path !== 'string') return false;
  const expected = pattern === '/' ? [] : pattern.slice(1).split('/');
  const actual = path === '/' ? [] : path.startsWith('/') ? path.slice(1).split('/') : null;
  if (!actual || expected.length !== actual.length) return false;
  return expected.every((segment, index) => ENDPOINT_PARAMETER.test(segment)
    ? /^[A-Za-z0-9][A-Za-z0-9._~:@_-]{0,127}$/.test(actual[index])
    : segment === actual[index]);
}

function endpointRequestMatches(endpoint, payload, endpointOrigin) {
  if (!record(endpoint)) return false;
  if (Array.isArray(endpoint.routes)) {
    const request = endpointRequest(payload, endpointOrigin);
    if (request === null || request.origin !== endpointOrigin || request.hash !== '') return false;
    return endpoint.routes.some((route) => route.method === request.method
      && (Object.hasOwn(route, 'path')
        ? endpointPathMatches(route.path, request.path)
        : request.path.startsWith(route['path-prefix']))
      && request.queryParameters.every((parameter) => route['query-params'].includes(parameter))
      && (request.search === '' || request.searchParams.size === request.queryParameters.length)
      && Object.entries(route['query-values'] ?? {}).every(([parameter, value]) => (
        request.searchParams.getAll(parameter).length === 1
          && request.searchParams.get(parameter) === value
      )));
  }
  if (!Object.hasOwn(endpoint, 'path')) return true;
  const request = endpointRequest(payload, endpointOrigin);
  return request !== null
    && request.origin === endpointOrigin
    && request.method === endpoint.method
    && request.search === ''
    && request.hash === ''
    && endpointPathMatches(endpoint.path, request.path);
}

function endpointSupportsDeclaredRedirects(endpoint) {
  const routes = Array.isArray(endpoint?.routes)
    ? endpoint.routes
    : [{ method: endpoint?.method, 'query-params': [], 'query-values': {} }];
  return routes.every((route) => (
    ['GET', 'HEAD'].includes(route.method)
    && (route['query-params'] ?? []).every((parameter) => (
      Object.hasOwn(route['query-values'] ?? {}, parameter)
    ))
  ));
}

function snapshotPayloadValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof globalThis.structuredClone !== 'function') {
    throw new Error('client operation payload cannot be snapshotted safely');
  }
  return globalThis.structuredClone(value);
}

function snapshotOperationPayload(payload, operation, endpointOrigin, request) {
  if (!record(payload) || !Object.hasOwn(payload, 'input') || typeof Request === 'undefined') {
    throw new Error('client operation request cannot be snapshotted');
  }
  const input = payload.input;
  const source = (input instanceof Request)
    ? input.clone()
    : new URL(
      (typeof URL !== 'undefined' && input instanceof URL) ? input.href : input,
      endpointOrigin,
    ).href;
  const init = record(payload.init) ? { ...payload.init } : {};
  const redirectOrigins = operation['redirect-origins'] ?? [];
  const redirect = redirectOrigins.length > 0
    && ['GET', 'HEAD'].includes(request.method)
    ? 'follow'
    : 'error';
  const requestSnapshot = new Request(source, {
    ...init,
    method: request.method,
    credentials: 'omit',
    redirect,
  });
  const requestUrl = new URL(requestSnapshot.url);
  if (requestUrl.origin !== endpointOrigin) {
    throw new Error('client request changed while its approved scope was being captured');
  }

  const snapshot = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'input' || key === 'init') continue;
    snapshot[key] = snapshotPayloadValue(value);
  }
  snapshot.input = requestSnapshot;
  // Request now owns the method, headers, body, credentials, redirect mode,
  // and other Fetch options. Do not let an adapter reapply mutable init data.
  snapshot.init = Object.freeze({ method: requestSnapshot.method });
  return Object.freeze(snapshot);
}

/** Match an app request against one declared endpoint. */
export function clientEndpointAllowsRequest(endpoint, input, method = 'GET') {
  if (!record(endpoint) || !validEndpoint(endpoint)) return false;
  const payload = { input, init: { method } };
  const request = endpointRequest(payload, endpoint.origin);
  return request !== null
    && request.origin === endpoint.origin
    && !request.hasCredentials
    && endpointRequestMatches(endpoint, payload, endpoint.origin);
}

function operationSelector(operation) {
  return JSON.stringify([operation.capability, operation.service, operation.operation]);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function freezeClone(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeClone));
  if (record(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, freezeClone(child)])
    ));
  }
  return value;
}

function serviceAdapter(serviceAdapters, service, operation) {
  if (!record(serviceAdapters) || !Object.hasOwn(serviceAdapters, service)) return undefined;
  const operations = serviceAdapters[service];
  if (!record(operations) || !Object.hasOwn(operations, operation)) return undefined;
  return operations[operation];
}

/**
 * Validate a JSON-compatible kotoba.app.client-runtime.v1 descriptor.
 * appOrigins defaults to the current page/Worker origin; static builders can
 * pass every configured app origin. Release/signature and bundle-byte checks
 * remain the verifier adapter's responsibility, matching kotoba.protocol.install.
 */
export function clientRuntimeProblems(runtime, requestedCapabilities = [], appOrigins = globalThis.location?.origin) {
  const problems = [];
  const applicationOrigins = new Set((Array.isArray(appOrigins) ? appOrigins : [appOrigins])
    .filter((origin) => typeof origin === 'string' && origin.length > 0));
  if (!record(runtime)) return [{ field: 'client-runtime', error: 'invalid-shape' }];
  const requiredKeys = ['entry', 'local-state', 'operations', 'profile', 'schema', 'target'];
  if (Object.keys(runtime).some((key) => !RUNTIME_KEYS.includes(key))
      || requiredKeys.some((key) => !Object.hasOwn(runtime, key))) {
    problems.push({ field: 'client-runtime', error: 'invalid-keys' });
  }
  if (runtime.schema !== 'kotoba.app.client-runtime.v1') {
    problems.push({ field: 'schema', error: 'invalid-schema' });
  }
  if (runtime.target !== 'browser') problems.push({ field: 'target', error: 'invalid-target' });
  if (!['trusted-page-v1', 'restricted-wasm-v1'].includes(runtime.profile)) {
    problems.push({ field: 'profile', error: 'invalid-profile' });
  }
  if (!validEntry(runtime.entry)) problems.push({ field: 'entry', error: 'invalid-entry' });

  if (Object.hasOwn(runtime, 'workers')) {
    if (!Array.isArray(runtime.workers)) {
      problems.push({ field: 'workers', error: 'invalid-workers' });
    } else {
      const ids = new Set();
      for (const worker of runtime.workers) {
        if (!exactKeys(worker, ['entry', 'id', 'protocol'])
            || !validName(worker.id) || !validEntry(worker.entry) || !validName(worker.protocol)) {
          problems.push({ field: 'workers', error: 'invalid-worker' });
          continue;
        }
        if (ids.has(worker.id)) problems.push({ field: 'workers', error: 'duplicate-worker-id' });
        ids.add(worker.id);
      }
    }
  }

  const state = runtime['local-state'];
  if (!exactKeys(state, ['adapter', 'schema', 'version'])
      || !['indexeddb', 'opfs', 'localstorage'].includes(state.adapter)
      || !validName(state.schema)
      || !Number.isSafeInteger(state.version)
      || state.version < 1) {
    problems.push({ field: 'local-state', error: 'invalid-local-state' });
  }

  if (!Array.isArray(runtime.operations)) {
    problems.push({ field: 'operations', error: 'invalid-operations' });
  } else {
    const requested = new Set(Array.isArray(requestedCapabilities) ? requestedCapabilities : []);
    const seen = new Set();
    for (const operation of runtime.operations) {
      const requiredOperationKeys = OPERATION_KEYS.filter((key) => key !== 'redirect-origins');
      const hasValidOperationKeys = exactKeys(operation, requiredOperationKeys)
        || exactKeys(operation, OPERATION_KEYS);
      if (!hasValidOperationKeys
          || !validName(operation.capability)
          || !validName(operation.service)
          || !validName(operation.operation)
          || !Array.isArray(operation['data-categories'])
          || !operation['data-categories'].every(validName)
          || !validEndpoint(operation.endpoint)
          || (Object.hasOwn(operation, 'redirect-origins')
            && (!Array.isArray(operation['redirect-origins'])
              || operation['redirect-origins'].length > 16
              || !operation['redirect-origins'].every(validRedirectOrigin)
              || new Set(operation['redirect-origins']).size !== operation['redirect-origins'].length))
          || operation.consent !== 'each-operation') {
        problems.push({ field: 'operations', error: 'invalid-operation' });
        continue;
      }
      const selector = operationSelector(operation);
      if (seen.has(selector)) problems.push({ field: 'operations', error: 'duplicate-operation' });
      seen.add(selector);
      if (!requested.has(operation.capability)) {
        problems.push({ field: 'operations', error: 'capability-not-requested', selector });
      }
      if (operation.endpoint !== 'user-selected'
          && record(operation.endpoint)
          && applicationOrigins.has(operation.endpoint.origin)) {
        problems.push({ field: 'operations', error: 'service-origin-is-app-origin', selector });
      }
      for (const redirectOrigin of operation['redirect-origins'] ?? []) {
        if ([...applicationOrigins].some((origin) => redirectOriginAllows(redirectOrigin, origin))) {
          problems.push({ field: 'operations', error: 'redirect-origin-is-app-origin', selector });
        }
      }
      if ((operation['redirect-origins'] ?? []).length > 0
          && !endpointSupportsDeclaredRedirects(operation.endpoint)) {
        problems.push({ field: 'operations', error: 'redirects-require-read-only-fixed-query', selector });
      }
      if (operation.capability === 'net/http-post') {
        problems.push({ field: 'operations', error: 'generic-network-capability', selector });
      }
    }
  }
  return problems;
}

function validInferenceRequestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function inferenceHistoryProblems(history) {
  if (!Array.isArray(history) || history.length > 8) return ['invalid-history'];
  let size = 0;
  for (const message of history) {
    if (!exactKeys(message, ['content', 'role'])
        || !['assistant', 'user'].includes(message.role)
        || typeof message.content !== 'string'
        || message.content.length > 12000) return ['invalid-history-message'];
    size += message.content.length;
    if (size > 12000) return ['history-too-large'];
  }
  return [];
}

/** Validate a host-to-Worker kotoba.inference.v1 request before dispatch. */
export function clientInferenceRequestProblems(message) {
  if (!record(message)) return [{ field: 'message', error: 'invalid-shape' }];
  const problems = [];
  const type = message.type;
  if (message.protocol !== CLIENT_INFERENCE_PROTOCOL) {
    problems.push({ field: 'protocol', error: 'invalid-protocol' });
  }
  if (!Object.hasOwn(INFERENCE_REQUEST_KEYS, type)) {
    problems.push({ field: 'type', error: 'unsupported-type' });
    return problems;
  }
  const typeKeys = INFERENCE_REQUEST_KEYS[type];
  const allowedKeys = ['protocol', 'requestId', 'type', ...typeKeys];
  if (Object.keys(message).some((key) => !allowedKeys.includes(key))) {
    problems.push({ field: 'message', error: 'unknown-fields' });
  }
  if (!validInferenceRequestId(message.requestId)) {
    problems.push({ field: 'requestId', error: 'invalid-request-id' });
  }
  if (type === 'load') {
    if (!validName(message.modelId)) problems.push({ field: 'modelId', error: 'invalid-model-id' });
    if (Object.hasOwn(message, 'history')) {
      problems.push(...inferenceHistoryProblems(message.history).map((error) => ({ field: 'history', error })));
    }
    if (Object.hasOwn(message, 'approvedOperations')
        && (!Array.isArray(message.approvedOperations)
          || message.approvedOperations.length > 64
          || !message.approvedOperations.every(record))) {
      problems.push({ field: 'approvedOperations', error: 'invalid-approved-operations' });
    }
  }
  if (type === 'generate'
      && (typeof message.prompt !== 'string' || message.prompt.length === 0 || message.prompt.length > 8000)) {
    problems.push({ field: 'prompt', error: 'invalid-prompt' });
  }
  return problems;
}

/** Validate a Worker-to-host kotoba.inference.v1 event before UI handling. */
export function clientInferenceEventProblems(message) {
  if (!record(message)) return [{ field: 'message', error: 'invalid-shape' }];
  const problems = [];
  const type = message.type;
  const eventKeys = {
    status: ['message'],
    ready: [],
    delta: ['text'],
    done: [],
    error: ['message'],
  };
  if (message.protocol !== CLIENT_INFERENCE_PROTOCOL) {
    problems.push({ field: 'protocol', error: 'invalid-protocol' });
  }
  if (!Object.hasOwn(eventKeys, type)) {
    problems.push({ field: 'type', error: 'unsupported-type' });
    return problems;
  }
  const eventFields = eventKeys[type];
  const allowedKeys = ['protocol', 'requestId', 'type', ...eventFields];
  if (Object.keys(message).some((key) => !allowedKeys.includes(key))) {
    problems.push({ field: 'message', error: 'unknown-fields' });
  }
  if (!validInferenceRequestId(message.requestId)) {
    problems.push({ field: 'requestId', error: 'invalid-request-id' });
  }
  if (type === 'delta'
      && (typeof message.text !== 'string' || message.text.length === 0 || message.text.length > 65536)) {
    problems.push({ field: 'text', error: 'invalid-delta' });
  }
  if (['status', 'error'].includes(type)
      && (typeof message.message !== 'string' || message.message.length === 0 || message.message.length > 1024)) {
    problems.push({ field: 'message', error: 'invalid-message' });
  }
  return problems;
}

/** Create an immutable, schema-checked kotoba.inference.v1 request. */
export function createClientInferenceRequest(type, requestId, fields = {}) {
  if (!record(fields)) throw new TypeError('inference request fields must be an object');
  const message = Object.freeze({ ...fields, protocol: CLIENT_INFERENCE_PROTOCOL, type, requestId });
  const problems = clientInferenceRequestProblems(message);
  if (problems.length) {
    throw new TypeError(`invalid inference request: ${problems.map(({ field, error }) => `${field}:${error}`).join(', ')}`);
  }
  return message;
}

/** Create an immutable, schema-checked kotoba.inference.v1 event. */
export function createClientInferenceEvent(type, requestId, fields = {}) {
  if (!record(fields)) throw new TypeError('inference event fields must be an object');
  const message = Object.freeze({ ...fields, protocol: CLIENT_INFERENCE_PROTOCOL, type, requestId });
  const problems = clientInferenceEventProblems(message);
  if (problems.length) {
    throw new TypeError(`invalid inference event: ${problems.map(({ field, error }) => `${field}:${error}`).join(', ')}`);
  }
  return message;
}

const OFFLINE_CONTENT_POLICY = Object.freeze([
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'self' blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
].join('; '));

/**
 * Add a per-document policy before launching a local-only app session.
 * Static app headers remain authoritative and the extra policy can only
 * restrict their allowed sources; it cannot grant a new network destination.
 */
export function applyOfflineClientPolicy(documentObject = globalThis.document) {
  if (!documentObject?.head || typeof documentObject.createElement !== 'function') {
    throw new Error('offline client policy requires a document head');
  }
  const existing = documentObject.querySelector?.('meta[data-kotoba-offline-policy="v1"]');
  if (existing) return existing;
  const policy = documentObject.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = OFFLINE_CONTENT_POLICY;
  policy.setAttribute('data-kotoba-offline-policy', 'v1');
  documentObject.head.append(policy);
  return policy;
}

/**
 * Render a static-host connect-src directive from declared operation and
 * redirect origins. Additional sources must already be declared by an
 * operation; this helper cannot widen the app's network boundary.
 */
export function clientRuntimeConnectSrc(runtime, requestedCapabilities = [], additionalSources = [], appOrigins = globalThis.location?.origin) {
  const problems = clientRuntimeProblems(runtime, requestedCapabilities, appOrigins);
  if (problems.length) {
    throw new Error(`invalid client runtime descriptor: ${problems.map(({field, error}) => `${field}:${error}`).join(', ')}`);
  }
  const origins = new Set(["'self'"]);
  for (const operation of runtime.operations) {
    origins.add(operation.endpoint.origin);
    for (const redirectOrigin of operation['redirect-origins'] ?? []) origins.add(redirectOrigin);
  }
  for (const source of additionalSources) {
    if (!validRedirectOrigin(source) || !origins.has(source)) {
      throw new Error('additional connect-src entries must be declared by a client operation');
    }
  }
  return `connect-src ${[...origins].sort().join(' ')}`;
}

/**
 * Apply the same exact intersection as kotoba.protocol.install:
 * signed operation declaration ∩ full local approval ∩ host-supported
 * [capability, service, operation] selectors.
 */
export function effectiveClientOperations(runtime, {
  requestedCapabilities = [],
  approvedOperations = [],
  hostSupportedOperations = [],
} = {}) {
  if (clientRuntimeProblems(runtime, requestedCapabilities).length) return [];
  const approved = new Set(approvedOperations.filter(record).map(canonical));
  const supported = new Set(hostSupportedOperations
    .filter((selector) => Array.isArray(selector) && selector.length === 3
      && selector.every((part) => typeof part === 'string'))
    .map((selector) => JSON.stringify(selector)));
  return runtime.operations.filter((operation) => (
    approved.has(canonical(operation))
    && supported.has(operationSelector(operation))
  ));
}

/**
 * Build a fail-closed operation broker. Each service/operation must have its
 * own host adapter; the app never supplies an arbitrary URL or fetch options.
 */
export function createClientOperationBroker({
  runtime,
  requestedCapabilities,
  approvedOperations,
  hostSupportedOperations,
  serviceAdapters = {},
  confirmOperation,
}) {
  const operations = effectiveClientOperations(runtime, {
    requestedCapabilities,
    approvedOperations,
    hostSupportedOperations,
  }).map(freezeClone);
  const bySelector = new Map(operations.map((operation) => [operationSelector(operation), operation]));

  return Object.freeze({
    operations: Object.freeze(operations),
    async invoke(selector, payload) {
      const operation = bySelector.get(JSON.stringify([
        selector?.capability, selector?.service, selector?.operation,
      ]));
      if (!operation) throw new Error('client operation is not approved and supported');
      const adapter = serviceAdapter(serviceAdapters, operation.service, operation.operation);
      if (typeof adapter !== 'function') throw new Error('client operation adapter is not supported');

      const endpointOrigin = operation.endpoint.origin;

      if (typeof globalThis.location?.origin === 'string'
          && endpointOrigin === globalThis.location.origin) {
        throw new Error('service endpoint must be distinct from the app origin');
      }
      const initialRequest = endpointRequest(payload, endpointOrigin);
      if (initialRequest?.hasCredentials) {
        throw new Error('service request URL must not include credentials');
      }
      if (initialRequest && initialRequest.origin !== endpointOrigin) {
        throw new Error('client request does not match the approved service origin');
      }
      if (!endpointRequestMatches(operation.endpoint, payload, endpointOrigin)) {
        throw new Error('service request does not match the approved endpoint method and path');
      }
      const approvedPayload = snapshotOperationPayload(payload, operation, endpointOrigin, initialRequest);
      const request = endpointRequest(approvedPayload, endpointOrigin);
      if (!request || request.hasCredentials
          || !endpointRequestMatches(operation.endpoint, approvedPayload, endpointOrigin)) {
        throw new Error('service request changed while its approved scope was being captured');
      }

      if (operation.consent === 'each-operation') {
        if (typeof confirmOperation !== 'function') {
          throw new Error('per-operation confirmation is unavailable');
        }
        const approved = await confirmOperation(Object.freeze({
          capability: operation.capability,
          service: operation.service,
          operation: operation.operation,
          endpointOrigin,
          endpointMethod: request?.method ?? null,
          endpointPath: request?.path ?? null,
          endpointSearch: request?.search ?? '',
          redirectOrigins: Object.freeze([...(operation['redirect-origins'] ?? [])]),
          dataCategories: Object.freeze([...operation['data-categories']]),
        }));
        if (approved !== true) throw new Error('client operation was not approved');
      }

      const result = await adapter({ operation, endpointOrigin, payload: approvedPayload });
      if (typeof Response !== 'undefined' && result instanceof Response) {
        if (result.type === 'opaqueredirect' || (result.status >= 300 && result.status < 400)) {
          throw new Error('service response redirect could not be verified');
        }
        if (!result.url) throw new Error('service response origin could not be verified');
        const responseOrigin = new URL(result.url).origin;
        const allowedOrigins = [endpointOrigin, ...(operation['redirect-origins'] ?? [])];
        if (!allowedOrigins.some((origin) => redirectOriginAllows(origin, responseOrigin))) {
          throw new Error('service response redirect origin is not declared');
        }
      }
      return result;
    },
  });
}
