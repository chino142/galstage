/**
 * 定时任务（蓝图 3.2「扩展性」）。纯逻辑，不碰时钟循环也不碰数据库 ——
 * 「什么时候该跑」在这里算，真正 setInterval / 落库 / 执行动作在 server/scheduler.mjs。
 *
 * 支持三种动作（每种的参数不同）：
 *   backup     全量备份（走 maintenance.createBackup，和手动备份同一条通道）
 *   cleanup    体检 + 清理失效数据（清理前会自动备份）
 *   summarize  给指定对话写小总结 / 大总结（走记忆服务）
 *
 * 时间按**服务器本地时区**算：自用工具，用户在哪个时区跑服务就按哪个时区。
 * 有意偏离：没有引入 cron 表达式（零依赖约束），只支持"每天 / 每周的某个时刻"，
 * 蓝图要的每天自动备份 / 清理 / 总结都在这个表达力之内。
 */

import { ValidationError } from '../errors.mjs';
import { newId, nowIso } from '../ids.mjs';

export const SCHEDULE_KINDS = [
  { id: 'backup', title: '自动备份', summary: '留一份完整快照（数据库 + 素材），保留份数沿用「备份与维护」里的设置' },
  { id: 'cleanup', title: '自动清理', summary: '体检并清理孤立素材 / 失效向量 / 重复消息，清理前会自动备份' },
  { id: 'summarize', title: '定时总结', summary: '给指定对话补一段小总结（或把已有小总结并成大总结）' },
];

export const SCHEDULE_FREQUENCIES = [
  { id: 'daily', title: '每天' },
  { id: 'weekly', title: '每周' },
];

export const WEEKDAYS = [
  { id: 0, title: '周日' },
  { id: 1, title: '周一' },
  { id: 2, title: '周二' },
  { id: 3, title: '周三' },
  { id: 4, title: '周四' },
  { id: 5, title: '周五' },
  { id: 6, title: '周六' },
];

export function getScheduleKind(id) {
  const found = SCHEDULE_KINDS.find((kind) => kind.id === id);
  if (!found) throw new ValidationError(`没有这种定时任务：${id}`);
  return found;
}

function intIn(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function pad(num) {
  return String(num).padStart(2, '0');
}

export function frequencyText(task) {
  const time = `${pad(intIn(task.atHour, 0, 23, 4))}:${pad(intIn(task.atMinute, 0, 59, 0))}`;
  if (task.every === 'weekly') return `每${WEEKDAYS[intIn(task.weekday, 0, 6, 0)].title} ${time}`;
  return `每天 ${time}`;
}

/** 正常化一条任务。`now` 用来给新建的任务设 createdAt。 */
export function normaliseTask(input = {}, now = new Date()) {
  const kind = getScheduleKind(input.kind ?? 'backup').id;
  const every = SCHEDULE_FREQUENCIES.some((item) => item.id === input.every) ? input.every : 'daily';
  const stamp = now instanceof Date ? now : new Date(now);
  const task = {
    id: input.id ? String(input.id) : newId('sch'),
    kind,
    label: String(input.label ?? '').trim(),
    enabled: input.enabled === true,
    every,
    atHour: intIn(input.atHour, 0, 23, 4),
    atMinute: intIn(input.atMinute, 0, 59, 0),
    weekday: intIn(input.weekday, 0, 6, 1),
    createdAt: input.createdAt ?? (Number.isNaN(stamp.getTime()) ? nowIso() : stamp.toISOString()),
    lastRunAt: input.lastRunAt ?? null,
    lastStatus: input.lastStatus ?? null,
    lastError: input.lastError ?? null,
    lastResult: input.lastResult ?? null,
    runCount: Number(input.runCount ?? 0) || 0,
    // 定时总结用：上次总结覆盖到的消息 seq，避免下一轮把同样的话再总结一遍
    lastSeq: Number.isFinite(Number(input.lastSeq)) ? Number(input.lastSeq) : null,
  };
  if (kind === 'summarize') {
    if (!input.chatId) throw new ValidationError('定时总结要指定一个对话（chatId）');
    task.chatId = String(input.chatId);
    task.level = input.level === 'large' ? 'large' : 'small';
    task.messagesPerRun = intIn(input.messagesPerRun, 4, 200, 40);
  }
  if (!task.label) task.label = `${getScheduleKind(kind).title}（${frequencyText(task)}）`;
  return task;
}

/** 下一次该跑的时刻（本地时区）。`from` 之后的第一个匹配点。 */
export function nextRunAt(task, from = new Date()) {
  const base = from instanceof Date ? from : new Date(from);
  const hour = intIn(task.atHour, 0, 23, 4);
  const minute = intIn(task.atMinute, 0, 59, 0);
  const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  if (task.every === 'weekly') {
    const target = intIn(task.weekday, 0, 6, 0);
    candidate.setDate(candidate.getDate() + ((target - candidate.getDay() + 7) % 7));
    if (candidate.getTime() <= base.getTime()) candidate.setDate(candidate.getDate() + 7);
    return candidate;
  }
  if (candidate.getTime() <= base.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/**
 * 现在该不该跑：
 *   - 没启用的不跑；
 *   - 没跑过时以 createdAt 为锚点，到点了才跑（新建任务不会立刻触发）；
 *   - 跑过就以 lastRunAt 为锚点 —— lastRunAt 落库了，所以重启不会把同一个时间点跑两遍；
 *     服务停机期间错过的，重启后补跑一次（不补多次）。
 */
export function isDue(task, now = new Date()) {
  if (!task?.enabled) return false;
  const anchor = task.lastRunAt ?? task.createdAt;
  if (!anchor) return false;
  return nextRunAt(task, new Date(anchor)).getTime() <= now.getTime();
}

/** 给界面用的形状：加"下次运行 / 是不是该跑了 / 频率文案"。 */
export function describeTask(task, now = new Date()) {
  const anchor = task.lastRunAt ?? task.createdAt;
  const due = isDue(task, now);
  return {
    ...task,
    kindTitle: getScheduleKind(task.kind).title,
    frequency: frequencyText(task),
    nextRunAt: anchor ? nextRunAt(task, new Date(anchor)).toISOString() : null,
    due,
  };
}

export function describeTasks(tasks = [], now = new Date()) {
  return tasks.map((task) => describeTask(task, now)).sort((a, b) => String(a.nextRunAt ?? '').localeCompare(String(b.nextRunAt ?? '')));
}

/**
 * 默认任务清单：只建出来、默认关着，用户去界面打开。
 * 总结任务必须指定对话，所以不做默认（用户自己加）。
 */
export function defaultTasks(now = new Date()) {
  return [
    normaliseTask({ kind: 'backup', enabled: false, every: 'daily', atHour: 4, atMinute: 0, label: '每天自动备份' }, now),
    normaliseTask({ kind: 'cleanup', enabled: false, every: 'weekly', weekday: 0, atHour: 4, atMinute: 30, label: '每周自动清理' }, now),
  ];
}

