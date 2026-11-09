window.__ModuleLoader__.load({
  id: 'dsh-reply-notification',
  factory: () => {
    const inject = ['uiWorkspace'];

    function apply(scope) {
      if (!globalThis.dshDesktop) return;

      scope.effect(() => {
        const controller = new AbortController();
        let timer;

        // 请求结束后再安排下一次，避免并发轮询或销毁后继续导航。
        async function poll() {
          try {
            // 桌面窗口不在前台时不消费跳转，避免其他桌面窗口抢先处理。
            if (!document.hasFocus()) return;
            const response = await fetch('api/reply-notification.next', {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (!controller.signal.aborted && typeof data?.sessionId === 'string' && data.sessionId.length > 0) {
              await scope.uiWorkspace.openSession(data.sessionId);
            }
          } catch (error) {
            if (!controller.signal.aborted) console.warn('[回复完成通知] 会话导航失败：', error);
          } finally {
            if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
          }
        }

        timer = setTimeout(poll, 1000);
        return () => {
          controller.abort();
          clearTimeout(timer);
        };
      }, 'reply-notification: navigation polling');
    }

    return { inject, apply };
  },
});
