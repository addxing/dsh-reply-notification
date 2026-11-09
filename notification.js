import { execFile } from 'node:child_process';
import { prepareNotifier } from './prepare-notifier.js';

const foregroundScript = 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js';

// 使用 AppKit 查询前台应用，不需要辅助功能或自动化权限，也不会切换焦点。
export function isDshFocused({ signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', foregroundScript],
      { signal, timeout: 2000, maxBuffer: 4096 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim() === 'com.deepseek.dsh');
      });
  });
}

// 发送前再检查一次焦点；查询失败交给调用方记录，不误发打扰用户。
export async function notifyUnlessFocused(notification, { signal, focused = isDshFocused, send = sendNotification } = {}) {
  if (await focused({ signal })) return false;
  signal?.throwIfAborted();
  await send(notification, { signal });
  return true;
}

// terminal-notifier 会解析参数为 plist，前面加空格避免特殊开头导致解析失败。
export function notifierArgs({ title, body, clickCommand, openDsh }) {
  const args = ['-title', ` ${title}`, '-message', ` ${body}`, '-sound', 'Glass'];
  // 即使点击通道失效，也保留唤起 DSH 的能力。
  if (clickCommand) args.push('-execute', clickCommand);
  if (openDsh || clickCommand) args.push('-open', 'dsh://open');
  return args;
}

// 合并换行并按 Unicode 字符截断，避免通知过长或截断 emoji。
export function notificationText(text, limit) {
  const chars = Array.from(String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim());
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
}

// 只向后读取本轮最后一条助手消息，不扫描整个历史，也不读取思考或工具结果。
export function buildNotification(session, event, sessionTitle) {
  let body = '';
  for (let seq = event.seq - 1; seq >= 0; seq--) {
    const previous = session.eventAt(seq);
    if (!previous || previous.type === 'turn/start' || previous.type === 'turn/end') break;
    if (previous.type !== 'assistant/message' || previous.data.turn !== event.data.turn) continue;
    if (!previous.data.interrupted) {
      body = previous.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join(' ');
    }
    break;
  }
  return {
    title: notificationText(sessionTitle.get(session)?.title, 80) || `会话 ${String(session.id).slice(0, 12)}`,
    body: notificationText(body, 120) || '回复已完成，可以回来查看。',
  };
}

// 待用户处理的请求只展示问题或工具名称，不暴露审批参数和工具结果。
export function buildInputNotification(session, request, kind, sessionTitle) {
  const question = request.questions?.find(item => typeof item.question === 'string')?.question;
  const detail = kind === 'approval'
    ? `需要审批${request.toolName ? `：${request.toolName}` : ''}`
    : question ? `需要回答：${question}` : '需要你确认或回答问题。';
  return {
    title: notificationText(sessionTitle.get(session)?.title, 80) || `会话 ${String(session.id).slice(0, 12)}`,
    body: notificationText(detail, 120),
  };
}

// 只旁观交互请求，立即交给原回答方；请求结束时取消尚未发出的通知。
export function createInputListener(kind, notify, onError) {
  return (request, next) => {
    const result = next();
    if (!request.agent?.session || request.signal?.aborted) return result;
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
    // 定时提问在无界面回答方时仍会等待，使用其原始 signal 管理通知生命周期。
    const completion = Promise.resolve(result).then(value => {
      controller.abort();
      return value;
    }, error => {
      if (!(kind === 'question' && request.wait?.timed && request.signal && error?.code === 'NO_PROVIDER')) controller.abort();
      throw error;
    });
    try {
      Promise.resolve(notify(request.agent.session, request, kind, signal)).catch(error => {
        if (!signal.aborted) onError(error);
      });
    } catch (error) {
      if (!signal.aborted) onError(error);
    }
    return completion;
  };
}

export async function sendNotification({ title, body, clickCommand, openDsh }, { signal } = {}) {
  const notifierPath = await prepareNotifier();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(notifierPath, notifierArgs({ title, body, clickCommand, openDsh }), { signal, timeout: 10000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error && stderr.trim()) error.message += `: ${stderr.trim()}`;
      if (error) reject(error);
      else resolve();
    });
  });
}

export function createTurnEndListener(agents, notify, onError) {
  const lastSeq = new WeakMap();
  return (session, event) => {
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return;
    if (session.header.origin === 'subagent') return;
    if (!agents.roots().some(agent => agent.id === session.id)) return;
    if ((lastSeq.get(session) ?? -1) >= event.seq) return;
    lastSeq.set(session, event.seq);
    // The post-commit observer never blocks or changes the agent's turn.
    try {
      Promise.resolve(notify(session, event)).catch(onError);
    } catch (error) {
      onError(error);
    }
  };
}
