import { buildNotification, createTurnEndListener, notifyUnlessFocused } from './notification.js';

export const inject = ['agents', 'sessionTitle'];

export function apply(ctx) {
  if (process.platform !== 'darwin') {
    throw new Error('回复完成通知目前仅支持 macOS。');
  }

  const pending = new Set();
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
    for (const controller of pending) controller.abort();
    pending.clear();
  });

  const notify = async (session, event) => {
    if (disposed) return;
    const controller = new AbortController();
    pending.add(controller);
    try {
      await notifyUnlessFocused(buildNotification(session, event, ctx.sessionTitle), { signal: controller.signal });
    } finally {
      pending.delete(controller);
    }
  };

  ctx.on('session/event', createTurnEndListener(ctx.agents, notify, error => {
    if (!disposed) console.warn('[回复完成通知] 系统通知发送失败：', error.message ?? error);
  }));
}
