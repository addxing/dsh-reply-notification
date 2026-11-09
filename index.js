import { buildInputNotification, buildNotification, createInputListener, createTurnEndListener, notifyUnlessFocused, sendNotification } from './notification.js';
import { createClickBridge } from './click-bridge.js';
import { createNavigation } from './navigation.js';

export const inject = ['agents', 'sessionTitle', 'connection'];

export async function apply(ctx) {
  if (process.platform !== 'darwin') {
    throw new Error('回复完成通知目前仅支持 macOS。');
  }

  const pending = new Set();
  let disposed = false;
  let bridge;
  const navigation = createNavigation(ctx);
  // 先绑定清理，再启动异步 socket，避免插件卸载时留下后台资源。
  ctx.effect(() => async () => {
    disposed = true;
    for (const controller of pending) controller.abort();
    pending.clear();
    await bridge?.dispose();
  });
  try {
    bridge = await createClickBridge(sessionId => navigation.open(sessionId));
    if (disposed) {
      await bridge.dispose();
      return;
    }
  } catch (error) {
    if (disposed) return;
    console.warn('[回复完成通知] 点击跳转不可用：', error.message ?? error);
  }

  // 通知正文和点击凭据分开，避免会话 ID 进入 shell 命令。
  const sendForSession = session => async (notification, options) => {
    let clickCommand;
    try {
      clickCommand = bridge?.register(String(session.id));
    } catch (error) {
      if (!disposed) console.warn('[回复完成通知] 点击跳转不可用：', error.message ?? error);
    }
    try {
      await sendNotification({ ...notification, clickCommand, openDsh: true }, options);
    } catch (error) {
      if (clickCommand) bridge?.revoke(clickCommand);
      throw error;
    }
  };

  const notify = async (session, event) => {
    if (disposed) return;
    const controller = new AbortController();
    pending.add(controller);
    try {
      await notifyUnlessFocused(buildNotification(session, event, ctx.sessionTitle), { signal: controller.signal, send: sendForSession(session) });
    } finally {
      pending.delete(controller);
    }
  };

  const onError = error => {
    if (!disposed) console.warn('[回复完成通知] 系统通知发送失败：', error.message ?? error);
  };
  // 在原回答方之前观察请求，仍由原回答方负责等待和处理用户输入。
  const notifyInput = async (session, request, kind, signal) => {
    if (disposed) return;
    const controller = new AbortController();
    pending.add(controller);
    try {
      await notifyUnlessFocused(buildInputNotification(session, request, kind, ctx.sessionTitle), {
        signal: AbortSignal.any([signal, controller.signal]),
        send: sendForSession(session),
      });
    } finally {
      pending.delete(controller);
    }
  };
  ctx.on('approval/request', createInputListener('approval', notifyInput, onError), { global: true, prepend: true });
  ctx.on('user-questions/request', createInputListener('question', notifyInput, onError), { global: true, prepend: true });
  ctx.on('session/event', createTurnEndListener(ctx.agents, notify, onError));
}
