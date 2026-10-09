/**
 * 定时任务执行器（蓝图 3.2「扩展性」）。
 *
 * "什么时候该跑"在 core/toolbox/scheduler.mjs 里算；这里只做三件事：
 *   1. 用一个 setInterval 定时看一眼有没有到点的任务（零依赖，不引 cron 库）；
 *   2. 把任务清单和"上次跑的时间"落进 app_meta —— 重启后不会把同一个时间点跑两遍；
 *   3. 真正执行动作（备份 / 清理 / 总结），走的是和手动操作完全一样的服务接口。
 *
 * 只由 HTTP 入口创建（MCP stdio 进程不该在后台跑备份），见 server/runtime.mjs。
 */

import { NotFoundError } from '../core/errors.mjs';
import { nowIso } from '../core/ids.mjs';
import {
  SCHEDULE_FREQUENCIES,
  SCHEDULE_KINDS,
  WEEKDAYS,
  defaultTasks,
  describeTask,
  describeTasks,
  isDue,
  normaliseTask,
} from '../core/toolbox/scheduler.mjs';
import { getMeta, setMeta } from './db/meta.mjs';

const META_KEY = 'scheduler.tasks';
const DEFAULT_INTERVAL_MS = 60 * 1000;

export function createScheduler({ engine, repo, chatStore, logger = console, intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date() }) {
  let timer = null;
  let starting = null;
  const running = new Set();
  const maintenance = () => engine.services.maintenance;
  const memory = () => engine.services.memory;

  function readTasks() {
    const stored = getMeta(repo, META_KEY, null);
    if (!Array.isArray(stored)) {
      const seeded = defaultTasks(now());
      setMeta(repo, META_KEY, seeded);
      return seeded;
    }
    const out = [];
    for (const raw of stored) {
      try {
        out.push(normaliseTask(raw, now()));
      } catch (err) {
        logger?.warn?.(`[scheduler] 丢掉一条坏的任务记录：${err?.message ?? err}`);
      }
    }
    return out;
  }

  function writeTasks(tasks) {
    setMeta(repo, META_KEY, tasks);
    return tasks;
  }

  function list() {
    return {
      items: describeTasks(readTasks(), now()),
      kinds: SCHEDULE_KINDS,
      frequencies: SCHEDULE_FREQUENCIES,
      weekdays: WEEKDAYS,
      running: Boolean(timer),
      intervalMs,
      dueCount: readTasks().filter((task) => isDue(task, now())).length,
    };
  }

  function save(input = {}) {
    const tasks = readTasks();
    if (input.id) {
      const index = tasks.findIndex((task) => task.id === input.id);
      if (index < 0) throw new NotFoundError(`定时任务 ${input.id}`);
      const merged = normaliseTask({ ...tasks[index], ...input, id: tasks[index].id }, now());
      tasks[index] = merged;
      writeTasks(tasks);
      return describeTask(merged, now());
    }
    const created = normaliseTask({ ...input, enabled: input.enabled === true }, now());
    tasks.push(created);
    writeTasks(tasks);
    return describeTask(created, now());
  }

  function remove(id) {
    const tasks = readTasks();
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    tasks.splice(index, 1);
    writeTasks(tasks);
    return true;
  }

  // ------------------------------------------------------------------ 动作

  async function execute(task) {
    if (task.kind === 'backup') {
      const made = maintenance().createBackup({ label: `定时备份：${task.label}`, kind: 'scheduled' });
      return { status: 'ok', detail: `备份 ${made.name}（${made.bytesText ?? made.bytes ?? ''}）` };
    }
    if (task.kind === 'cleanup') {
      const result = maintenance().cleanup({ backupFirst: true });
      const removed = (result.targets ?? []).length;
      return { status: 'ok', detail: `清理了 ${removed} 类数据，释放 ${result.bytesText ?? 0}` };
    }
    if (task.kind === 'summarize') return summarize(task);
    return { status: 'skipped', detail: `不知道该怎么执行 ${task.kind}` };
  }

  async function summarize(task) {
    const chat = chatStore?.getChat?.(task.chatId);
    if (!chat) return { status: 'skipped', detail: `对话已经不在了：${task.chatId}` };
    if (task.level === 'large') {
      const result = await memory().summarizeLarge({ chatId: task.chatId });
      return { status: 'ok', detail: `写了大总结：${result.memory?.title ?? ''}` };
    }
    const afterSeq = Number.isFinite(Number(task.lastSeq)) ? Number(task.lastSeq) : 0;
    let messages = chatStore.listMessages(task.chatId, { afterSeq });
    if (messages.length > task.messagesPerRun) messages = messages.slice(-task.messagesPerRun);
    if (!messages.length) return { status: 'skipped', detail: '没有新消息，跳过' };
    const result = await memory().summarizeSmall({
      chatId: task.chatId,
      messages,
      title: `${chat.title} · ${nowIso().slice(0, 10)}`,
    });
    const lastSeq = Math.max(...messages.map((message) => Number(message.seq) || 0));
    return { status: 'ok', detail: `写了小总结（${messages.length} 条消息 → ${result.memory?.id ?? ''}）`, patch: { lastSeq } };
  }

  // ------------------------------------------------------------------ 跑

  /** 跑一条任务（id 或任务对象）。同时在跑的同一条任务会被跳过。 */
  async function runTask(id) {
    const tasks = readTasks();
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new NotFoundError(`定时任务 ${id}`);
    const task = tasks[index];
    if (running.has(task.id)) return describeTask(task, now());
    running.add(task.id);
    const startedAt = nowIso();
    let outcome;
    try {
      outcome = await execute(task);
    } catch (err) {
      outcome = { status: 'error', detail: err?.message ?? String(err) };
    } finally {
      running.delete(task.id);
    }
    // 结果重新读一遍，避免和这一轮里的其它修改打架
    const latest = readTasks();
    const at = latest.findIndex((item) => item.id === task.id);
    if (at < 0) return null;
    const updated = {
      ...latest[at],
      lastRunAt: startedAt,
      lastStatus: outcome.status,
      lastError: outcome.status === 'error' ? outcome.detail : null,
      lastResult: outcome.detail ?? null,
      runCount: Number(latest[at].runCount ?? 0) + 1,
      ...(outcome.patch ?? {}),
    };
    latest[at] = updated;
    writeTasks(latest);
    const level = outcome.status === 'error' ? 'warn' : 'info';
    logger?.[level]?.(`[scheduler] ${task.label} → ${outcome.status}：${outcome.detail ?? ''}`);
    return describeTask(updated, now());
  }

  /** 定期看一眼：哪条到点了就跑。tick 里单条失败不影响其它条。 */
  async function tick() {
    const tasks = readTasks();
    const current = now();
    for (const task of tasks) {
      if (!isDue(task, current)) continue;
      try {
        await runTask(task.id);
      } catch (err) {
        logger?.warn?.(`[scheduler] 跑「${task.label}」失败：${err?.message ?? err}`);
      }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void tick().catch((err) => logger?.warn?.(`[scheduler] tick 出错：${err?.message ?? err}`));
    }, intervalMs);
    timer.unref?.();
    // 启动时补跑一次：服务停机期间错过的任务在这里补上（每条最多补一次）
    starting = setTimeout(() => {
      starting = null;
      void tick().catch((err) => logger?.warn?.(`[scheduler] 启动补跑出错：${err?.message ?? err}`));
    }, 1500);
    starting.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (starting) clearTimeout(starting);
    timer = null;
    starting = null;
  }

  return { list, save, remove, runTask, tick, start, stop, readTasks };
}

