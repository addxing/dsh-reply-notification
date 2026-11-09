import test from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createClickBridge } from '../click-bridge.js';

const run = promisify(exec);

// 测试使用独立的临时目录，根据目录项找到真实 socket，不增加生产接口。
async function fixture(options = {}, onClick = () => {}) {
  const parent = await mkdtemp('/tmp/cb-');
  let bridge;
  try {
    bridge = await createClickBridge(onClick, { ...options, tempDir: parent });
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
  const [name] = await readdir(parent);
  const directory = join(parent, name);
  return {
    bridge, directory, socketPath: join(directory, 'socket'),
    async cleanup() {
      await bridge.dispose();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

// 只从测试命令中提取凭据，并通过真实 Unix socket 发送原始数据。
function tokenFrom(command) {
  const match = /^printf '%s\\n' '([0-9a-f]{64})' \| /.exec(command);
  assert.ok(match, 'command contains a 256-bit hex token');
  return match[1];
}

function send(socketPath, data) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => socket.end(data));
    socket.on('error', reject);
    socket.on('close', resolve);
  });
}

test('真实命令触发对应会话，凭据只可使用一次', async t => {
  const calls = [];
  const f = await fixture({}, id => calls.push(id));
  t.after(() => f.cleanup());
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  const id = 'session-id-private';
  const command = f.bridge.register(id);
  const token = tokenFrom(command);
  assert.equal(command.includes(id), false);
  await run(command);
  assert.deepEqual(calls, [id]);
  await send(f.socketPath, `${token}\n`);
  await run(command);
  assert.deepEqual(calls, [id]);
});

test('拒绝畸形、过长和未知消息，且不消耗有效凭据', async t => {
  const calls = [];
  const f = await fixture({}, id => calls.push(id));
  t.after(() => f.cleanup());
  const token = tokenFrom(f.bridge.register('valid'));
  for (const message of [token, `${token}\nextra`, `${token.toUpperCase()}\n`, `${'0'.repeat(64)}\n`, `${token}\r\n`, 'x'.repeat(4096)]) {
    await send(f.socketPath, message);
  }
  assert.deepEqual(calls, []);
  await send(f.socketPath, `${token}\n`);
  assert.deepEqual(calls, ['valid']);
});

test('发送失败时撤销凭据并释放容量', async t => {
  const calls = [];
  const f = await fixture({ maxTokens: 1 }, id => calls.push(id));
  t.after(() => f.cleanup());
  const command = f.bridge.register('failed');
  const token = tokenFrom(command);
  f.bridge.revoke(command);
  f.bridge.revoke(command);
  await send(f.socketPath, `${token}\n`);
  assert.deepEqual(calls, []);
  await run(f.bridge.register('next'));
  assert.deepEqual(calls, ['next']);
});

test('TTL 和容量限制生效，过期凭据不会触发', async t => {
  let clock = 100;
  const calls = [];
  const f = await fixture({ ttlMs: 10, maxTokens: 1, now: () => clock }, id => calls.push(id));
  t.after(() => f.cleanup());
  const old = tokenFrom(f.bridge.register('old'));
  assert.throws(() => f.bridge.register('full'), /limit/);
  clock = 110;
  await send(f.socketPath, `${old}\n`);
  assert.deepEqual(calls, []);
  const next = tokenFrom(f.bridge.register('next'));
  await send(f.socketPath, `${next}\n`);
  assert.deepEqual(calls, ['next']);
});

test('路径 shell 引号安全，回调异常不影响后续请求', async t => {
  // 特殊字符让实际 shell 执行路径转义，而不依赖命令字符串的形状。
  const parent = await mkdtemp("/tmp/cb-'$(id)-");
  let bridge;
  t.after(async () => {
    if (bridge) await bridge.dispose();
    await rm(parent, { recursive: true, force: true });
  });
  const calls = [];
  bridge = await createClickBridge(id => {
    calls.push(id);
    if (id === 'throw') throw new Error('private error');
    if (id === 'reject') return Promise.reject(new Error('private error'));
  }, { tempDir: parent });
  await run(bridge.register('throw'));
  await run(bridge.register('reject'));
  await run(bridge.register('ok'));
  assert.deepEqual(calls, ['throw', 'reject', 'ok']);
});

test('dispose 关闭连接、移除目录并阻止注册，可重复调用', async t => {
  const calls = [];
  const f = await fixture({}, id => calls.push(id));
  t.after(() => f.cleanup());
  const token = tokenFrom(f.bridge.register('no'));
  const socket = connect(f.socketPath);
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(token);
  await Promise.all([f.bridge.dispose(), f.bridge.dispose()]);
  await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  assert.throws(() => f.bridge.register('no'), /disposed/);
  assert.deepEqual(calls, []);
});

test('非法资源选项被拒绝', async () => {
  await assert.rejects(createClickBridge(() => {}, { ttlMs: 0 }), RangeError);
  await assert.rejects(createClickBridge(() => {}, { maxTokens: 0 }), RangeError);
});
