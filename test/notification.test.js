import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInputNotification, createInputListener, createTurnEndListener, notifierArgs, notifyUnlessFocused } from '../notification.js';

const session = { id: 'session-123456789', header: { origin: 'user' } };
const title = { get: () => ({ title: '测试会话' }) };

test('点击命令和 DSH 唤起链接传入通知程序', () => {
  assert.deepEqual(notifierArgs({ title: '标题', body: '正文', clickCommand: 'safe-command' }), [
    '-title', ' 标题', '-message', ' 正文', '-sound', 'Glass',
    '-execute', 'safe-command', '-open', 'dsh://open',
  ]);
  assert.deepEqual(notifierArgs({ title: '标题', body: '正文', openDsh: true }).slice(-2), ['-open', 'dsh://open']);
  assert.equal(notifierArgs({ title: '标题', body: '正文' }).includes('-execute'), false);
});

test('审批与提问通知只包含安全的摘要', () => {
  assert.deepEqual(buildInputNotification(session, { toolName: 'bash', reason: 'secret' }, 'approval', title), {
    title: '测试会话', body: '需要审批：bash',
  });
  assert.deepEqual(buildInputNotification(session, { questions: [{ question: '是否继续？', detail: 'secret' }] }, 'question', title), {
    title: '测试会话', body: '需要回答：是否继续？',
  });
  assert.equal(buildInputNotification(session, {}, 'question', title).body, '需要你确认或回答问题。');
});

test('等待用户输入时通知并保持回答方结果不变', async () => {
  let finish;
  const answer = new Promise(resolve => { finish = resolve; });
  const notifications = [];
  const listener = createInputListener('question', (...args) => notifications.push(args), assert.fail);
  const result = listener({ agent: { session } }, () => answer);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0], session);
  assert.equal(notifications[0][2], 'question');
  assert.equal(notifications[0][3].aborted, false);
  finish({ answers: [] });
  assert.deepEqual(await result, { answers: [] });
  assert.equal(notifications[0][3].aborted, true);
});

test('取消及回答方失败不改变原始结果', async () => {
  const controller = new AbortController();
  const error = new Error('answer failed');
  let sentSignal;
  const listener = createInputListener('approval', (_session, _request, _kind, signal) => { sentSignal = signal; }, assert.fail);
  const result = listener({ agent: { session }, signal: controller.signal }, () => Promise.reject(error));
  controller.abort();
  assert.equal(sentSignal.aborted, true);
  await assert.rejects(result, actual => actual === error);
  let called = false;
  assert.equal(listener({ agent: { session }, signal: controller.signal }, () => { called = true; return 7; }), 7);
  assert.equal(called, true);
});

test('无回答方的定时提问继续等待，通知只随原请求中止', async () => {
  const controller = new AbortController();
  const error = Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' });
  let noticeSignal;
  const listener = createInputListener('question', (_session, _request, _kind, signal) => { noticeSignal = signal; }, assert.fail);
  await assert.rejects(listener({ agent: { session }, signal: controller.signal, wait: { timed: true } }, () => Promise.reject(error)), actual => actual === error);
  assert.equal(noticeSignal.aborted, false);
  controller.abort();
  assert.equal(noticeSignal.aborted, true);
});

test('通知失败不影响回答，取消后不报告通知错误', async () => {
  const errors = [];
  let rejectNotice;
  const listener = createInputListener('question', () => new Promise((_, reject) => { rejectNotice = reject; }), error => errors.push(error));
  const result = listener({ agent: { session } }, () => Promise.resolve('answer'));
  assert.equal(await result, 'answer');
  rejectNotice(new Error('aborted'));
  await Promise.resolve();
  assert.deepEqual(errors, []);
});

test('通知同步抛错或请求中止都不会阻断原有交互', async () => {
  const failure = new Error('notification failed');
  const errors = [];
  const listener = createInputListener('approval', () => { throw failure; }, error => errors.push(error));
  const answer = await listener({ agent: { session } }, () => Promise.resolve('rejected'));
  assert.equal(answer, 'rejected');
  assert.deepEqual(errors, [failure]);
  let notified = false;
  const noSession = createInputListener('question', () => { notified = true; }, assert.fail);
  assert.equal(noSession({}, () => 'unchanged'), 'unchanged');
  assert.equal(notified, false);
});

test('前台静默，取消后不发送通知', async () => {
  let count = 0;
  const send = async () => { count++; };
  assert.equal(await notifyUnlessFocused({}, { focused: async () => true, send }), false);
  const controller = new AbortController();
  await assert.rejects(notifyUnlessFocused({}, { signal: controller.signal, focused: async () => { controller.abort(); return false; }, send }));
  assert.equal(count, 0);
});

test('原有回复通知只发送正常完成的主会话', () => {
  const sent = [];
  const listener = createTurnEndListener({ roots: () => [{ id: session.id }] }, (...args) => sent.push(args), assert.fail);
  const event = { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } };
  listener(session, event);
  listener(session, event);
  listener(session, { ...event, seq: 2, data: { reason: { kind: 'cancelled' } } });
  listener({ ...session, header: { origin: 'subagent' } }, event);
  assert.equal(sent.length, 1);
});
