/**
 * 一轮生成完的通知（蓝图 3.2「使用体验」）。
 *
 * 两个开关，各自独立：
 *   ui.notifySound    响一下：用 WebAudio 现合成一声轻响，不需要音频文件（零依赖）。
 *   ui.notifyBrowser  系统通知：需要授权，只在用户**打开开关那一刻**请求一次；
 *                     已经被拒绝就只提示一句，不再反复弹（浏览器自己也会拒）。
 */

import { getSetting } from '../core/prefs.mjs';

/** 打开开关时调一次，返回 'granted' | 'denied' | 'unsupported'。 */
export async function requestNotifyPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function notifyTurnDone({ title = 'Silver Tavern', body = '' } = {}) {
  if (getSetting('ui.notifySound', false)) playChime();
  if (!getSetting('ui.notifyBrowser', false)) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    // silent: true —— 通知本身不响，声音交给上面的开关，避免两个一起响
    new Notification(title, { body, silent: true });
  } catch {
    // 通知失败不影响聊天
  }
}

/** 一声很轻的提示音：两个正弦音前后叠一下，比"叮"柔和。 */
function playChime() {
  try {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    for (const [frequency, offset] of [[880, 0], [1320, 0.09]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.05, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.28);
      osc.start(now + offset);
      osc.stop(now + offset + 0.3);
    }
    setTimeout(() => ctx.close?.(), 700);
  } catch {
    // 没有音频权限 / 没有 AudioContext 时静默
  }
}
