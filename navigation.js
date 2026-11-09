// 点击只保留最新会话；路由读取并清空它，不使用请求中的任何数据。
export function createNavigation(ctx) {
  let pending = null;
  let disposed = false;

  const dispose = ctx.effect(() => {
    const unregister = ctx.connection.fetch.register({
      path: '/api/reply-notification.next',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: () => {
        const sessionId = pending;
        pending = null;
        return Response.json({ sessionId }, { headers: { 'cache-control': 'no-store' } });
      },
    });
    return () => {
      disposed = true;
      pending = null;
      return unregister();
    };
  }, 'reply-notification: navigation route');

  return {
    open(sessionId) {
      if (!disposed && typeof sessionId === 'string' && sessionId.length > 0) pending = sessionId;
    },
    dispose,
  };
}
