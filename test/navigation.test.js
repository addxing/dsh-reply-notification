import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNavigation } from '../navigation.js';

// 模拟 Cordis effect 的立即注册和幂等销毁。
function effect(setup) {
  const cleanup = setup();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    return cleanup?.();
  };
}

function host() {
  let route;
  let unregisters = 0;
  const ctx = {
    effect,
    connection: { fetch: { register(value) {
      route = value;
      return effect(() => () => { unregisters++; });
    } } },
  };
  const navigation = createNavigation(ctx);
  return { navigation, route, unregisters: () => unregisters };
}

test('精确 POST 路由只消费最新点击，忽略客户端提交的数据', async () => {
  const { navigation, route } = host();
  assert.equal(route.path, '/api/reply-notification.next');
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.requestBody, 'buffered');
  assert.deepEqual(await route.fetch().json(), { sessionId: null });
  navigation.open('older');
  navigation.open('latest');
  const request = new Request('http://localhost/api/reply-notification.next', { method: 'POST', body: '{"sessionId":"attacker"}' });
  const response = route.fetch(request);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { sessionId: 'latest' });
  assert.deepEqual(await route.fetch(request).json(), { sessionId: null });
});

test('无效会话不覆盖已有点击，销毁清理队列且只注销一次', async () => {
  const { navigation, route, unregisters } = host();
  navigation.open('valid');
  navigation.open('');
  navigation.open(null);
  assert.deepEqual(await route.fetch().json(), { sessionId: 'valid' });
  navigation.open('pending');
  navigation.dispose();
  navigation.dispose();
  navigation.open('after');
  assert.equal(unregisters(), 1);
  assert.deepEqual(await route.fetch().json(), { sessionId: null });
});

test('上下文销毁注销路由并停止接收点击', async () => {
  let contextDispose;
  let route;
  let unregistered = 0;
  const navigation = createNavigation({
    effect(setup) { contextDispose = effect(setup); return contextDispose; },
    connection: { fetch: { register(value) { route = value; return () => { unregistered++; }; } } },
  });
  navigation.open('pending');
  contextDispose();
  navigation.open('late');
  navigation.dispose();
  assert.equal(unregistered, 1);
  assert.deepEqual(await route.fetch().json(), { sessionId: null });
});

test('路由注册异常向调用方传播', () => {
  const failure = new Error('duplicate route');
  assert.throws(() => createNavigation({ effect, connection: { fetch: { register() { throw failure; } } } }), error => error === failure);
});

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

// 用隔离的 classic 脚本环境模拟 loader、定时器和同源 fetch。
function client({ desktop = true, focused = true, fetchImpl = async () => ({ ok: true, json: async () => ({ sessionId: null }) }), openSession = () => {} } = {}) {
  const timers = new Map();
  const warnings = [];
  let nextTimer = 0;
  let registration;
  let cleanup;
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    dshDesktop: desktop,
    document: { hasFocus: () => focused },
    AbortController,
    fetch: fetchImpl,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { warn: (...args) => warnings.push(args) },
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  const plugin = registration.factory(() => { throw new Error('unexpected dependency'); });
  plugin.apply({ uiWorkspace: { openSession }, effect(setup) { cleanup = effect(setup); return cleanup; } });
  return {
    registration, plugin, timers, warnings,
    dispose: () => cleanup?.(),
    tick() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.fn();
      return timer.delay;
    },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('classic factory 仅在桌面轮询固定同源端点并导航', async () => {
  const calls = [];
  const opened = [];
  const app = client({
    fetchImpl: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ sessionId: 'session-1' }) }; },
    openSession: id => opened.push(id),
  });
  assert.equal(app.registration.id, 'dsh-reply-notification');
  assert.deepEqual(Array.from(app.plugin.inject), ['uiWorkspace']);
  assert.equal(app.tick(), 1000);
  await flush();
  assert.deepEqual(opened, ['session-1']);
  assert.equal(calls[0][0], 'api/reply-notification.next');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(app.timers.size, 1);
  app.dispose();
  assert.equal(calls[0][1].signal.aborted, true);
  assert.equal(app.timers.size, 0);
  const web = client({ desktop: false });
  assert.equal(web.timers.size, 0);
});

test('桌面未获得焦点时保留待处理点击', async () => {
  let calls = 0;
  const app = client({ focused: false, fetchImpl: async () => { calls++; } });
  app.tick();
  await flush();
  assert.equal(calls, 0);
  assert.equal(app.timers.size, 1);
  app.dispose();
});

test('请求、响应解析和导航异常后继续轮询；无效响应不导航', async () => {
  let count = 0;
  const opened = [];
  const app = client({
    fetchImpl: async () => {
      count++;
      if (count === 1) throw new Error('network');
      if (count === 2) return { ok: false, status: 401 };
      if (count === 3) return { ok: true, json: async () => { throw new Error('bad json'); } };
      return { ok: true, json: async () => ({ sessionId: count === 4 ? 42 : 'valid' }) };
    },
    openSession: id => { opened.push(id); throw new Error('open failed'); },
  });
  for (let i = 0; i < 5; i++) { app.tick(); await flush(); }
  assert.deepEqual(opened, ['valid']);
  assert.equal(app.warnings.length, 4);
  assert.equal(app.timers.size, 1);
  app.dispose();
});

test('销毁中止进行中的请求，即使迟到响应也不导航或重新轮询', async () => {
  let resolveFetch;
  let signal;
  const opened = [];
  const app = client({
    fetchImpl: (_url, options) => { signal = options.signal; return new Promise(resolve => { resolveFetch = resolve; }); },
    openSession: id => opened.push(id),
  });
  app.tick();
  app.dispose();
  assert.equal(signal.aborted, true);
  resolveFetch({ ok: true, json: async () => ({ sessionId: 'late' }) });
  await flush();
  assert.deepEqual(opened, []);
  assert.equal(app.timers.size, 0);
  assert.equal(app.warnings.length, 0);
});
