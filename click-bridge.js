import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 1024;
const MAX_CONNECTIONS = 32;

// 单引号包住路径，并安全转义其中的单引号，不让 shell 解释路径内容。
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// 每个桥使用私有目录；可注入时间与容量，便于调用方和测试控制资源。
export async function createClickBridge(onClick, {
  ttlMs = DEFAULT_TTL_MS,
  maxTokens = DEFAULT_MAX_TOKENS,
  now = Date.now,
  tempDir = tmpdir(),
} = {}) {
  if (typeof onClick !== 'function' || typeof now !== 'function') throw new TypeError('Invalid callback or clock');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new RangeError('Invalid token limits');
  }

  // mkdtemp 按 0700 创建目录，即使 socket 文件可见也不能从目录外访问。
  const directory = await mkdtemp(join(tempDir, 'dsh-click-'));
  const socketPath = join(directory, 'socket');
  const tokens = new Map();
  const commands = new Map();
  const connections = new Set();
  let disposed = false;
  let disposal;

  const server = createServer(socket => {
    if (disposed || connections.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let message = Buffer.alloc(0);
    socket.on('data', chunk => {
      // 只接受 64 个小写十六进制字符和一个换行，超长立即断开。
      if (message.length + chunk.length > 65) {
        socket.destroy();
        return;
      }
      message = Buffer.concat([message, chunk]);
    });
    socket.on('end', () => {
      if (disposed || message.length !== 65) return;
      const text = message.toString('utf8');
      if (!/^[0-9a-f]{64}\n$/.test(text)) return;
      const token = text.slice(0, 64);
      const entry = tokens.get(token);
      if (!entry) return;
      // 先删除再检查和调用，重复点击或回调失败均不能再次消费。
      tokens.delete(token);
      commands.delete(entry.command);
      if (entry.expiresAt <= now()) return;
      try {
        Promise.resolve(onClick(entry.sessionId)).catch(() => {});
      } catch {
        // 同步和异步回调错误都不影响 listener。
      }
    });
  });
  // 运行期 socket 错误不能引起未处理异常或泄露 token。
  server.on('error', () => {});

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    // 过期项在注册时清理，达到上限时拒绝新增，不挤掉仍有效的通知。
    register(sessionId) {
      if (disposed) throw new Error('Click bridge is disposed');
      const current = now();
      for (const [token, entry] of tokens) {
        if (entry.expiresAt <= current) {
          tokens.delete(token);
          commands.delete(entry.command);
        }
      }
      if (tokens.size >= maxTokens) throw new Error('Click bridge token limit reached');
      let token;
      do token = randomBytes(32).toString('hex'); while (tokens.has(token));
      // 命令只携带随机凭据；隐藏 nc 错误，避免通知点击失败时输出信息。
      const command = `printf '%s\\n' '${token}' | /usr/bin/nc -w 2 -U ${shellQuote(socketPath)} >/dev/null 2>&1`;
      tokens.set(token, { sessionId, command, expiresAt: current + ttlMs });
      commands.set(command, token);
      return command;
    },

    // 通知未发送成功时释放凭据，避免无效通知占满容量。
    revoke(command) {
      const token = commands.get(command);
      if (token === undefined) return;
      commands.delete(command);
      tokens.delete(token);
    },

    // 可重复调用；主动关闭未完成的连接，再移除私有目录。
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      tokens.clear();
      commands.clear();
      for (const socket of connections) socket.destroy();
      disposal = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        .finally(() => rm(directory, { recursive: true, force: true }));
      return disposal;
    },
  };
}
