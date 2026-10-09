/**
 * ComfyUI 纯逻辑：工作流解析、可填参数、占位符替换、事件与队列解释。
 *
 * 这里不碰 HTTP、不碰数据库 —— 只有"把 ComfyUI 的 JSON 说人话"的函数，
 * 所以能直接单测。真正发请求的是 server/toolbox/comfy.mjs。
 *
 * 兼容性依据（对着 ComfyUI master 分支源码核过，不是凭记忆写的）：
 *   server.py                     —— @routes.get('/ws')、@routes.post('/prompt')、
 *                                    @routes.get('/queue')、@routes.get('/history/{prompt_id}')、
 *                                    @routes.get('/view')、@routes.get('/object_info')、
 *                                    get_queue_info() 里 queue_remaining
 *   execution.py                  —— send_sync('executing', {node, display_node, prompt_id})、
 *                                    send_sync('executed', {node, output, prompt_id})、
 *                                    send_sync('execution_error', ...)、add_message('execution_start'/'execution_cached'/'execution_success')
 *   comfy_execution/progress.py   —— send_sync('progress_state', {prompt_id, nodes})
 * 结论（本文件据此实现）：
 *   POST /prompt   {prompt, client_id, prompt_id?} → 200 {prompt_id, number, node_errors}；400 {error, node_errors}
 *   GET  /queue    → {queue_running:[...], queue_pending:[...]}，每条是数组，[0]=序号、[1]=prompt_id
 *   GET  /history/{prompt_id} → {[prompt_id]: {prompt, outputs, status}}
 *   GET  /view?filename=&subfolder=&type=output → 图片字节
 *   带 client_id 提交后，WebSocket 只会把该 client 的事件推给它自己（server.py 用
 *   self.client_id 作为 send 的 sid），所以我们固定一个 clientId 就能收到自己那批图的事件。
 *
 * 有意偏离：ComfyUI 自己的前端同时渲染 `progress` 与 `progress_state` 两种进度消息，
 * 我们只归并成"当前节点 + value/max"一条进度（这是给聊天界面看的小进度条，
 * 不需要每层子图各画一条）。归并在 mapComfyEvent 里做，逻辑等价。
 */

import { NotFoundError, ValidationError } from '../errors.mjs';
import {
  ASSET_REF_PREFIX,
  COMFY_EXECUTION_MODES,
  COMFY_TERMINAL_STATUSES,
  applyAssetRefs,
  collectHistoryImages,
  collectAssetRefs,
  comfyErrorMessage,
  comfyWsUrl,
  describeFetchError,
  getComfyExecutionMode,
  guessMime,
  historyStatus,
  isComfyTerminal,
  isAssetRef,
  makeAssetRef,
  mapComfyEvent,
  normaliseBaseUrl,
  progressPercent,
  readAssetRef,
  summariseQueue,
} from '../../web/core/comfy-events.mjs';

export const COMFY_WORKFLOW_KINDS = [
  { id: 'portrait', title: '立绘', summary: '角色正面像，一般要固定种子' },
  { id: 'expression', title: '表情差分', summary: '同一角色的一组表情' },
  { id: 'background', title: '背景', summary: '场景 / 环境图' },
  { id: 'cg', title: 'CG', summary: '关键剧情大图' },
  { id: 'inpaint', title: '局部重绘', summary: '圈一块区域改' },
  { id: 'custom', title: '自定义', summary: '其它工作流' },
];

export function getWorkflowKind(id) {
  const kind = COMFY_WORKFLOW_KINDS.find((item) => item.id === id);
  if (!kind) throw new NotFoundError(`ComfyUI 工作流类型 ${id}`);
  return kind;
}

/** 可填参数能用的占位符。发请求前会被替换成当前对话的真实内容。 */
export const COMFY_PLACEHOLDERS = [
  { key: 'char', title: '角色名', example: '{{char}}', hint: '当前说话角色的名字' },
  { key: 'user', title: '玩家名', example: '{{user}}', hint: '你的角色名' },
  { key: 'scene', title: '场景', example: '{{scene}}', hint: '地点 + 时间' },
  { key: 'emotion', title: '情绪', example: '{{emotion}}', hint: '角色当前情绪（有就填）' },
  { key: 'outfit', title: '当前服装', example: '{{outfit}}', hint: '角色现在这套衣服的描写（在 ComfyUI 页的「衣柜」里配）' },
  { key: 'action', title: '动作', example: '{{action}}', hint: '最近一段动作描写' },
  { key: 'date', title: '日期', example: '{{date}}', hint: '当天日期' },
];

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * 内置的示例工作流（蓝图 3.1「预设几个常用工作流」）。
 *
 * 都是最简骨架：CheckpointLoaderSimple + CLIPTextEncode×2 + EmptyLatentImage
 * + KSampler + VAEDecode + SaveImage（局部重绘多一个 LoadImage + VAEEncodeForInpaint）。
 * 用户导入后只要把 `ckpt_name` 改成自己机器上的模型名就能出图。
 *
 * 这些是纯数据，放在 core 里而不是写死在前端 —— 前端只负责"点一下把它落库"，
 * 以后想加预设（比如图生图、LoRA）改这一个文件。
 */
const NEGATIVE_DEFAULT = 'lowres, bad anatomy, bad hands, extra digits, extra limbs, worst quality, jpeg artifacts, watermark, signature';

function text2imgWorkflow({ prefix, positive, negative = NEGATIVE_DEFAULT, width, height, steps = 24, cfg = 7, checkpoint = 'sd_xl_base_1.0.safetensors', batchSize = 1 }) {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: batchSize } },
    5: {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps,
        cfg,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['6', 0] } },
  };
}

export const COMFY_WORKFLOW_PRESETS = [
  {
    id: 'preset-portrait',
    title: '立绘（最简文生图）',
    kind: 'portrait',
    summary: '角色正面像。把 ckpt_name 换成你的模型名即可；种子在界面上固定。',
    note: '骨架工作流：CheckpointLoaderSimple + CLIPTextEncode×2 + EmptyLatentImage + KSampler + SaveImage。',
    workflow: text2imgWorkflow({
      prefix: 'silver_tavern_portrait',
      width: 512,
      height: 768,
      positive: 'masterpiece, best quality, {{char}}, {{emotion}}, upper body, looking at viewer, detailed face, detailed eyes, soft lighting',
    }),
  },
  {
    id: 'preset-expression',
    title: '表情差分（最简文生图）',
    kind: 'expression',
    summary: '同一角色的一组表情。要一次出多张就把 batch_size 调大，把表情写进提示词。',
    note: '和立绘同一套骨架，只是提示词模板换成了表情向。',
    workflow: text2imgWorkflow({
      prefix: 'silver_tavern_expression',
      width: 512,
      height: 512,
      positive: 'masterpiece, best quality, {{char}}, {{emotion}}, portrait, face focus, expression sheet, neutral background',
    }),
  },
  {
    id: 'preset-background',
    title: '背景（最简文生图）',
    kind: 'background',
    summary: '场景 / 环境图。{{scene}} 会换成当前地点与时间。',
    note: '横构图，负向词里排掉了人物。',
    workflow: text2imgWorkflow({
      prefix: 'silver_tavern_background',
      width: 768,
      height: 512,
      negative: 'people, humans, characters, 1girl, 1boy, worst quality, lowres, watermark, signature',
      positive: 'masterpiece, best quality, scenery, {{scene}}, no humans, detailed background, atmospheric lighting, wide shot',
    }),
  },
  {
    id: 'preset-cg',
    title: 'CG（最简文生图）',
    kind: 'cg',
    summary: '关键剧情大图。{{action}} 会接上最近一段动作描写。',
    note: '横构图，偏电影感。',
    workflow: text2imgWorkflow({
      prefix: 'silver_tavern_cg',
      width: 832,
      height: 512,
      positive: 'masterpiece, best quality, cinematic composition, {{char}}, {{scene}}, {{action}}, {{emotion}}, dramatic lighting, detailed',
    }),
  },
  {
    id: 'preset-inpaint',
    title: '局部重绘（最简骨架）',
    kind: 'inpaint',
    summary: '把参考图放进 ComfyUI 的 input 目录，改 LoadImage 里的文件名；图的透明通道就是重绘区域。',
    note: '局部重绘要多一个 LoadImage + VAEEncodeForInpaint：mask 取参考图的 alpha 通道，denoise 默认 0.75。',
    workflow: {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: '{{char}}, {{emotion}}, detailed, repaired area, best quality', clip: ['1', 1] } },
      3: { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE_DEFAULT, clip: ['1', 1] } },
      8: { class_type: 'LoadImage', inputs: { image: 'example.png', upload: 'image' } },
      9: { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['8', 0], vae: ['1', 2], mask: ['8', 1], grow_mask_by: 6 } },
      5: {
        class_type: 'KSampler',
        inputs: {
          seed: 0,
          steps: 24,
          cfg: 7,
          sampler_name: 'dpmpp_2m',
          scheduler: 'karras',
          denoise: 0.75,
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['9', 0],
        },
      },
      6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      7: { class_type: 'SaveImage', inputs: { filename_prefix: 'silver_tavern_inpaint', images: ['6', 0] } },
    },
  },
  {
    id: 'preset-img2img',
    title: '图生图（拿参考图出新姿势）',
    kind: 'portrait',
    summary: '把参考图放进 ComfyUI 的 input 目录（或从「参考图」选一张已有素材），改 LoadImage 与 denoise 即可。',
    note: '骨架：CheckpointLoaderSimple + LoadImage + VAEEncode + CLIPTextEncode×2 + KSampler(denoise 0.6) + VAEDecode + SaveImage。',
    workflow: {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      8: { class_type: 'LoadImage', inputs: { image: 'example.png', upload: 'image' } },
      10: { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['1', 2] } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, best quality, {{char}}, {{emotion}}, {{scene}}, new pose, detailed', clip: ['1', 1] } },
      3: { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE_DEFAULT, clip: ['1', 1] } },
      5: {
        class_type: 'KSampler',
        inputs: {
          seed: 0,
          steps: 24,
          cfg: 7,
          sampler_name: 'dpmpp_2m',
          scheduler: 'karras',
          denoise: 0.6,
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['10', 0],
        },
      },
      6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      7: { class_type: 'SaveImage', inputs: { filename_prefix: 'silver_tavern_img2img', images: ['6', 0] } },
    },
  },
  {
    id: 'preset-outpaint',
    title: '扩图（往外补画面）',
    kind: 'inpaint',
    summary: '参考图的透明通道就是"要补的那一圈"；grow_mask_by 已调大，denoise 1.0。',
    note: '骨架：与局部重绘同一套，只是 grow_mask_by=48、denoise=1.0，提示词偏"更宽的景"。',
    workflow: {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, best quality, {{scene}}, {{action}}, wide shot, expanded background, continuous scenery', clip: ['1', 1] } },
      3: { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE_DEFAULT, clip: ['1', 1] } },
      8: { class_type: 'LoadImage', inputs: { image: 'example.png', upload: 'image' } },
      9: { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['8', 0], vae: ['1', 2], mask: ['8', 1], grow_mask_by: 48 } },
      5: {
        class_type: 'KSampler',
        inputs: {
          seed: 0,
          steps: 24,
          cfg: 7,
          sampler_name: 'dpmpp_2m',
          scheduler: 'karras',
          denoise: 1,
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['9', 0],
        },
      },
      6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      7: { class_type: 'SaveImage', inputs: { filename_prefix: 'silver_tavern_outpaint', images: ['6', 0] } },
    },
  },
  {
    id: 'preset-hires',
    title: '高清放大（先出小图再放大重采）',
    kind: 'portrait',
    summary: '先按小尺寸出一张，再放大 1.5 倍、用小 denoise 重采一遍 —— 细节更多、脸更稳。',
    note: '骨架：文生图 → LatentUpscale（放大）→ 第二个 KSampler（denoise 0.5 重绘）→ 解码。全是 ComfyUI 自带节点。',
    workflow: {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, best quality, {{char}}, {{scene}}, {{emotion}}, detailed', clip: ['1', 1] } },
      3: { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE_DEFAULT, clip: ['1', 1] } },
      4: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
      5: {
        class_type: 'KSampler',
        inputs: { seed: 0, steps: 24, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] },
      },
      6: { class_type: 'LatentUpscale', inputs: { upscale_method: 'nearest-exact', width: 1152, height: 1536, crop: 'disabled', samples: ['5', 0] } },
      7: {
        class_type: 'KSampler',
        inputs: { seed: 1, steps: 18, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 0.5, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['6', 0] },
      },
      8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
      9: { class_type: 'SaveImage', inputs: { filename_prefix: 'silver_tavern_hires', images: ['8', 0] } },
    },
  },
  {
    id: 'preset-controlnet',
    title: 'ControlNet 姿势控制（按参考图摆姿势）',
    kind: 'portrait',
    summary: '拿一张姿势图（骨架 / 线稿）控制构图 —— 同一个动作换角色，或同一角色换动作。',
    note: '需要你机器上有 ControlNet 模型：把 ControlNetLoader 里的 control_net_name 改成实际文件名。'
      + '骨架用的是 ComfyUI 自带的 ControlNetLoader + ControlNetApplyAdvanced；如果你的版本这两个节点输入名不一样，导入后在 ComfyUI 里重连一下再导出。',
    workflow: {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, best quality, {{char}}, {{emotion}}', clip: ['1', 1] } },
      3: { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE_DEFAULT, clip: ['1', 1] } },
      4: { class_type: 'LoadImage', inputs: { image: 'example.png', upload: 'image' } },
      5: { class_type: 'ControlNetLoader', inputs: { control_net_name: 'control_v11p_sd15_openpose.pth' } },
      6: {
        class_type: 'ControlNetApplyAdvanced',
        inputs: { strength: 1, start_percent: 0, end_percent: 0.8, positive: ['2', 0], negative: ['3', 0], control_net: ['5', 0], image: ['4', 0] },
      },
      7: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
      8: {
        class_type: 'KSampler',
        inputs: { seed: 0, steps: 24, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['1', 0], positive: ['6', 0], negative: ['6', 1], latent_image: ['7', 0] },
      },
      9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['1', 2] } },
      10: { class_type: 'SaveImage', inputs: { filename_prefix: 'silver_tavern_controlnet', images: ['9', 0] } },
    },
  },
];

/**
 * 从一份**已经能跑**的工作流里，把"模型是怎么来的"和"采样参数"读出来。
 *
 * 为什么需要它：模型有两种装法 ——
 *   ① 一体化 checkpoint（一个文件里装着 UNET + CLIP + VAE，SD1.5 / SDXL 那种）；
 *   ② 拆开加载（UNETLoader + CLIPLoader + VAELoader 各读一个文件，Flux / Qwen-Image 那种）。
 * 内置示例预设是按 ① 写的；如果用户的机器上是 ②（一个 checkpoint 都没有），
 * 那套预设就跑不动。有了这份 profile，就能**按用户自己的模型**生成一套对得上的预设。
 */
export function deriveLoaderProfile(workflow) {
  const prompt = parseApiWorkflow(workflow).prompt;
  const entries = Object.entries(prompt);
  const pick = (re) => entries.find(([, node]) => re.test(String(node?.class_type ?? ''))) ?? null;

  const checkpoint = pick(/^CheckpointLoaderSimple$/);
  const unet = pick(/^UNETLoader$/);
  const clip = pick(/^CLIPLoader$/);
  const vae = pick(/^VAELoader$/);

  let style = 'unknown';
  const loaders = [];
  if (checkpoint) {
    style = 'checkpoint';
    loaders.push({ id: checkpoint[0], class_type: checkpoint[1].class_type, inputs: { ...checkpoint[1].inputs } });
  } else if (unet || clip || vae) {
    style = 'split';
    for (const found of [unet, clip, vae]) {
      if (found) loaders.push({ id: found[0], class_type: found[1].class_type, inputs: { ...found[1].inputs } });
    }
  }
  if (style === 'split' && (!unet || !clip || !vae)) style = 'partial';

  const sampler = entries.find(([, node]) => /^KSampler$/i.test(String(node?.class_type ?? '')))?.[1] ?? null;
  const latent = entries.find(([, node]) => /^EmptyLatentImage$/i.test(String(node?.class_type ?? '')))?.[1] ?? null;
  return {
    style,
    loaders,
    modelName: checkpoint?.[1]?.inputs?.ckpt_name ?? unet?.[1]?.inputs?.unet_name ?? null,
    sampler: sampler
      ? {
          steps: Number(sampler.inputs?.steps) || 24,
          cfg: Number(sampler.inputs?.cfg) || 7,
          sampler_name: String(sampler.inputs?.sampler_name ?? 'dpmpp_2m'),
          scheduler: String(sampler.inputs?.scheduler ?? 'karras'),
        }
      : null,
    size: latent ? { width: Number(latent.inputs?.width) || 768, height: Number(latent.inputs?.height) || 1024 } : null,
  };
}

/** 按 profile 拼一张文生图骨架；`hires` 时再挂一段放大重采。 */
function graphFromProfile(profile, { prefix, positive, negative, width, height, steps, cfg, samplerName, scheduler, hires = false, batchSize = 1 }) {
  const nodes = {};
  let model;
  let clip;
  let vae;
  if (profile.style === 'checkpoint') {
    const src = profile.loaders[0];
    nodes['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ...src.inputs } };
    model = ['1', 0];
    clip = ['1', 1];
    vae = ['1', 2];
  } else {
    const by = (re) => profile.loaders.find((item) => re.test(item.class_type));
    nodes['1'] = { class_type: 'UNETLoader', inputs: { ...by(/UNETLoader/).inputs } };
    nodes['2'] = { class_type: 'CLIPLoader', inputs: { ...by(/CLIPLoader/).inputs } };
    nodes['3'] = { class_type: 'VAELoader', inputs: { ...by(/VAELoader/).inputs } };
    model = ['1', 0];
    clip = ['2', 0];
    vae = ['3', 0];
  }
  nodes['4'] = { class_type: 'CLIPTextEncode', inputs: { text: positive, clip } };
  nodes['5'] = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip } };
  nodes['6'] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: batchSize } };
  const samplerNode = (id, latentRef, denoise, seed) => ({
    class_type: 'KSampler',
    inputs: { seed, steps, cfg, sampler_name: samplerName, scheduler, denoise, model, positive: ['4', 0], negative: ['5', 0], latent_image: latentRef },
  });
  nodes['7'] = samplerNode('7', ['6', 0], 1, 0);
  let last = '7';
  if (hires) {
    nodes['8'] = {
      class_type: 'LatentUpscale',
      inputs: { upscale_method: 'nearest-exact', width: Math.round(width * 1.5), height: Math.round(height * 1.5), crop: 'disabled', samples: ['7', 0] },
    };
    nodes['9'] = samplerNode('9', ['8', 0], 0.5, 1);
    last = '9';
  }
  const dec = String(Number(last) + 1);
  const save = String(Number(last) + 2);
  nodes[dec] = { class_type: 'VAEDecode', inputs: { samples: [last, 0], vae } };
  nodes[save] = { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: [dec, 0] } };
  return nodes;
}

/**
 * 按用户自己那份工作流的"模型来源"，生成一套对得上的预设（立绘 / 表情 / 背景 / CG / 高清放大）。
 * 采样器、尺寸也跟着母版走 —— 母版能跑，这些就能跑。
 */
export function presetsFromProfile(profile, { sourceName = '' } = {}) {
  if (!profile || (profile.style !== 'checkpoint' && profile.style !== 'split')) return [];
  const s = profile.sampler ?? { steps: 24, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras' };
  const size = profile.size ?? { width: 768, height: 1024 };
  const common = { steps: s.steps, cfg: s.cfg, samplerName: s.sampler_name, scheduler: s.scheduler };
  const note = `按你导入的「${sourceName || '母版工作流'}」生成：模型来源与采样参数都跟它一致（${s.sampler_name} / ${s.scheduler} / ${s.steps} 步 / CFG ${s.cfg}）。`;
  const specs = [
    { id: 'derived-portrait', title: '立绘（按本机模型）', kind: 'portrait', prefix: 'silver_tavern_portrait', width: 768, height: 1024,
      positive: 'masterpiece, best quality, {{char}}, {{outfit}}, {{emotion}}, portrait, upper body, detailed face' },
    { id: 'derived-expression', title: '表情差分（按本机模型）', kind: 'expression', prefix: 'silver_tavern_expression', width: 768, height: 768,
      positive: 'masterpiece, best quality, {{char}}, {{outfit}}, {{emotion}}, portrait, face focus, expression sheet, neutral background' },
    { id: 'derived-background', title: '背景（按本机模型）', kind: 'background', prefix: 'silver_tavern_background', width: 1024, height: 768,
      positive: 'masterpiece, best quality, {{scene}}, scenery, no humans, detailed background' },
    { id: 'derived-cg', title: 'CG（按本机模型）', kind: 'cg', prefix: 'silver_tavern_cg', width: 1024, height: 1024,
      positive: 'masterpiece, best quality, {{char}}, {{outfit}}, {{emotion}}, {{scene}}, {{action}}, cinematic, key visual' },
    { id: 'derived-hires', title: '高清放大（按本机模型）', kind: 'portrait', prefix: 'silver_tavern_hires', width: 768, height: 1024, hires: true,
      positive: 'masterpiece, best quality, {{char}}, {{outfit}}, {{emotion}}, {{scene}}, detailed' },
  ];
  return specs.map((spec) => ({
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    summary: `${spec.width}×${spec.height}${spec.hires ? ' → 放大 1.5 倍重采' : ''}，用你本机的模型加载器`,
    note,
    workflow: graphFromProfile(profile, { prefix: spec.prefix, positive: spec.positive, negative: NEGATIVE_DEFAULT, width: spec.width, height: spec.height, hires: spec.hires, ...common }),
  }));
}

/** 给界面看的预设清单（不带整份工作流，只带能显示的信息）。 */
export function listWorkflowPresets() {
  return COMFY_WORKFLOW_PRESETS.map((preset) => ({
    id: preset.id,
    title: preset.title,
    kind: preset.kind,
    summary: preset.summary,
    note: preset.note,
    nodeCount: Object.keys(preset.workflow).length,
    placeholders: detectPlaceholders(preset.workflow),
  }));
}

export function getWorkflowPreset(id) {
  const found = COMFY_WORKFLOW_PRESETS.find((preset) => preset.id === id);
  if (!found) throw new NotFoundError(`ComfyUI 示例工作流 ${id}`);
  return found;
}

/**
 * 解析 ComfyUI「Save (API Format)」导出的 JSON。
 * 既接受裸的节点表 `{"3":{...}}`，也接受包了一层 `{prompt:{...}}` 的写法。
 */
export function parseApiWorkflow(input) {
  let data = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (err) {
      throw new ValidationError(`工作流不是合法 JSON：${err.message}`);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError('工作流 JSON 应该是一个对象（节点表）');
  }
  if (data.prompt && typeof data.prompt === 'object' && !Array.isArray(data.prompt)) data = data.prompt;

  const nodes = Object.entries(data).filter(
    ([, node]) => node && typeof node === 'object' && !Array.isArray(node) && typeof node.class_type === 'string',
  );
  if (!nodes.length) {
    throw new ValidationError(
      '这看起来不是 ComfyUI 的 API 格式工作流：一个带 class_type 的节点都没有。请在 ComfyUI 里用「Workflow → Export (API)」导出后再导入。',
    );
  }
  return { prompt: data, nodeCount: nodes.length };
}

function inputEntries(prompt) {
  const out = [];
  for (const [nodeId, node] of Object.entries(prompt ?? {})) {
    if (!node || typeof node !== 'object') continue;
    const classType = typeof node.class_type === 'string' ? node.class_type : 'Unknown';
    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
    for (const [input, value] of Object.entries(inputs)) {
      if (Array.isArray(value)) continue; // 形如 ["4", 0] 是连线，不是可填值
      out.push({ nodeId, classType, input, value, type: scalarType(value) });
    }
  }
  return out;
}

function scalarType(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

/** 工作流里所有能被填的标量输入（连线不算）。界面用它给用户挑参数。 */
export function workflowInputs(prompt) {
  return inputEntries(prompt);
}

const NUMERIC_HINTS = new Set(['width', 'height', 'steps', 'cfg', 'denoise', 'batch_size', 'shift', 'start_at_step', 'end_at_step']);
const SEED_RE = /seed/i;
/** LoadImage.image 是"参考图文件名"，值要先上传到 ComfyUI 再替换（图生图 / 重绘 / 扩图）。 */
export const IMAGE_INPUT_KEYS = new Set(['image']);

function bindingType(entry) {
  if (entry.classType === 'LoadImage' && IMAGE_INPUT_KEYS.has(entry.input)) return 'image';
  if (SEED_RE.test(entry.input)) return 'seed';
  if (entry.type === 'number') return NUMERIC_HINTS.has(entry.input) ? 'number' : 'text';
  if (entry.type === 'boolean') return 'boolean';
  return 'text';
}

/**
 * 导入时自动挑一批"可填参数"：
 *   - 有内容的文本输入（提示词、模型名、文件名）→ text
 *   - 第一个种子输入 → seed（种子固定就靠它）
 *   - 尺寸 / 步数 / cfg 这类数值 → number
 * 用户之后可以在界面上改这张绑定表。
 */
export function suggestBindings(prompt) {
  const bindings = [];
  let seedTaken = false;
  for (const entry of inputEntries(prompt)) {
    const type = bindingType(entry);
    if (type === 'seed') {
      if (seedTaken) continue;
      seedTaken = true;
    } else if (type === 'image') {
      // 参考图文件名一定有内容（LoadImage 默认 example.png），照收
    } else if (type === 'text') {
      if (entry.type !== 'string' || !String(entry.value ?? '').trim()) continue;
    } else if (type === 'number') {
      if (!NUMERIC_HINTS.has(entry.input)) continue;
    }
    bindings.push({
      nodeId: entry.nodeId,
      input: entry.input,
      label: `${entry.classType}.${entry.input}`,
      type,
      value: entry.value,
    });
  }
  return bindings;
}

/**
 * 采样器的正面 / 负面条件是从哪来的 —— 界面上那两个"提示词"框就填它俩。
 * 做法：先整张图里找 inputs.positive / inputs.negative 这两根线（KSampler 系列、CFGGuider 都这么连；
 * 只有 conditioning 没有正负之分的 Guider 退回用 conditioning），再顺着连线往上游走，
 * 直到撞上第一个带文本的 CLIPTextEncode —— 中间夹着 ConditioningCombine / ControlNetApply 这类节点也照穿。
 * 找不到可填的文本节点就返回 null，界面据此不显示输入框。
 */
export function detectPromptSlots(prompt) {
  const nodes = prompt ?? {};

  function traceText(startId) {
    const seen = new Set();
    const queue = [String(startId ?? '')];
    while (queue.length) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const node = nodes[id];
      if (!node || typeof node !== 'object') continue;
      const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
      if (node.class_type === 'CLIPTextEncode' && typeof inputs.text === 'string') {
        return { nodeId: id, input: 'text', classType: 'CLIPTextEncode', value: inputs.text };
      }
      for (const value of Object.values(inputs)) {
        if (Array.isArray(value) && typeof value[0] === 'string') queue.push(value[0]);
      }
    }
    return null;
  }

  function conditioningLink(name) {
    for (const [id, node] of Object.entries(nodes)) {
      const value = node?.inputs?.[name];
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    }
    return null;
  }

  const positive = conditioningLink('positive') ?? conditioningLink('conditioning');
  const negative = conditioningLink('negative');
  return {
    positive: positive ? traceText(positive) : null,
    negative: negative ? traceText(negative) : null,
  };
}

/** 工作流里出现了哪些占位符（去重）。 */
export function detectPlaceholders(prompt) {
  const found = new Set();
  for (const entry of inputEntries(prompt)) {
    if (typeof entry.value !== 'string') continue;
    for (const match of entry.value.matchAll(PLACEHOLDER_RE)) found.add(match[1]);
  }
  return [...found];
}

/**
 * 替换 {{char}} 这类占位符。未知的占位符原样留着，并记进 missing，
 * 免得用户写错名字却得到一个空提示词还找不到原因。
 */
export function substitute(text, context = {}, { keepUnknown = true } = {}) {
  const missing = new Set();
  const out = String(text ?? '').replace(PLACEHOLDER_RE, (raw, key) => {
    const value = context[key];
    if (value === undefined || value === null || value === '') {
      missing.add(key);
      return keepUnknown ? raw : '';
    }
    return String(value);
  });
  return { text: out, missing: [...missing] };
}

/**
 * 把替换后留下的空档收拾干净：`a, , 1girl` → `a, 1girl`。
 * 提示词是给图片模型看的，多个空逗号只会让它困惑。
 */
export function tidyPrompt(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.split(',').map((part) => part.trim()).filter(Boolean).join(', '))
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

/** 从当前对话拼出占位符上下文。 */
export function buildPlaceholderContext(input = {}) {
  const { chat = null, member = null, variables = {}, worldState = {}, content = '', name = null } = input;
  const persona = chat?.persona ?? {};
  const state = { ...(worldState ?? {}) };
  const place = state.place ?? '';
  const time = state.time ?? '';
  const out = {
    char: name ?? member?.name ?? chat?.title ?? '',
    user: persona.name ?? 'User',
    scene: [persona.scene, place, time].filter((item) => item && String(item).trim()).join(' · '),
    emotion: String(variables.emotion ?? state.emotion ?? ''),
    outfit: String(input.outfit ?? ''),
    action: String(variables.action ?? ''),
    date: new Date().toISOString().slice(0, 10),
    content: String(content ?? ''),
  };
  // 显式给的同名键优先：调用方（比如"手动出图"面板）可以直接覆盖某一个占位符，
  // 不用先伪造一份 worldState。
  for (const key of ['char', 'user', 'scene', 'emotion', 'outfit', 'action', 'date']) {
    const value = input[key];
    if (value !== undefined && value !== null && String(value) !== '') out[key] = String(value);
  }
  return out;
}

function setInput(prompt, nodeId, input, value) {
  const node = prompt?.[nodeId];
  if (!node || typeof node !== 'object') {
    throw new ValidationError(`工作流里没有节点 ${nodeId}`);
  }
  if (!node.inputs || typeof node.inputs !== 'object') node.inputs = {};
  if (!(input in node.inputs)) {
    throw new ValidationError(`节点 ${nodeId}（${node.class_type ?? '未知类型'}）没有输入 ${input}`);
  }
  node.inputs[input] = value;
}

function coerce(type, value) {
  if (type === 'image') return value === null || value === undefined ? '' : String(value);
  if (type === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new ValidationError(`参数应该是数字，实际是 ${JSON.stringify(value)}`);
    return num;
  }
  if (type === 'seed') {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new ValidationError(`种子应该是数字，实际是 ${JSON.stringify(value)}`);
    return Math.trunc(num);
  }
  if (type === 'boolean') return Boolean(value);
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 把绑定表 + 用户填的值 + 占位符上下文应用到一个工作流副本上。
 * @returns {{prompt:object, applied:Array, missing:string[], placeholders:string[]}}
 */
export function buildPrompt({ workflow, bindings = [], values = {}, context = {}, seed = null }) {
  const prompt = clone(workflow);
  const applied = [];
  const missing = new Set();
  for (const binding of bindings) {
    if (binding.enabled === false) continue;
    // 值的优先级：`节点id.输入名` > 输入名 > 绑定里的默认值
    let raw = binding.value;
    if (values[binding.input] !== undefined) raw = values[binding.input];
    if (values[`${binding.nodeId}.${binding.input}`] !== undefined) raw = values[`${binding.nodeId}.${binding.input}`];
    if (binding.type === 'seed' && seed !== null && seed !== undefined) raw = seed;
    if (binding.type === 'text' && typeof raw === 'string') {
      // 真正发出去的那一份不带 {{...}} 残留：填不上的占位符直接去掉（并在 missing 里报出来），
      // 免得图片模型把 "{{emotion}}" 当成提示词的一部分。
      const result = substitute(raw, context, { keepUnknown: false });
      raw = tidyPrompt(result.text);
      result.missing.forEach((key) => missing.add(key));
    }
    setInput(prompt, binding.nodeId, binding.input, coerce(binding.type, raw));
    applied.push({ nodeId: binding.nodeId, input: binding.input, type: binding.type, value: prompt[binding.nodeId].inputs[binding.input] });
  }
  return { prompt, applied, missing: [...missing], placeholders: detectPlaceholders(prompt) };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

// ---------------------------------------------------------------- LoRA

function clampStrength(value, fallback = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(-10, Math.min(10, Math.round(num * 100) / 100));
}

/** 收一收 LoRA 清单：名字去空、权重夹到 -10~10，最多 20 个。 */
export function normaliseLoras(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      name: String(item?.name ?? '').trim().slice(0, 200),
      strengthModel: clampStrength(item?.strengthModel, 1),
      strengthClip: clampStrength(item?.strengthClip, 1),
      trigger: String(item?.trigger ?? '').trim().slice(0, 200),
      enabled: item?.enabled !== false,
    }))
    .filter((item) => item.name)
    .slice(0, 20);
}

/**
 * 从 ComfyUI 的节点定义里挑出这台机器上有的 LoRA。
 * `/object_info/LoraLoader` 会返回 `input.required.lora_name = [[名字…], {}]`，
 * 第一项就是候选清单（ComfyUI 扫 models/loras 目录得到的）。
 */
export function extractLoraNames(objectInfo) {
  const names = new Set();
  for (const def of Object.values(objectInfo ?? {})) {
    const spec = def?.input?.required?.lora_name;
    if (!Array.isArray(spec) || !Array.isArray(spec[0])) continue;
    for (const name of spec[0]) if (typeof name === 'string' && name.trim()) names.add(name.trim());
  }
  return [...names].sort();
}

/**
 * 找 LoRA 该接在谁后面：
 *   1) 标准 checkpoint 加载器（CheckpointLoaderSimple / CheckpointLoader）：0 = MODEL、1 = CLIP；
 *   2) 找不到就退一步看"谁被当成 model / clip 用"。
 * 找不到 MODEL 就别硬改（宁可报出来，也不要把一份能跑的工作流改坏）。
 */
function findLoraSources(graph) {
  for (const [id, node] of Object.entries(graph ?? {})) {
    const classType = node?.class_type;
    if (classType === 'CheckpointLoaderSimple' || classType === 'CheckpointLoader') {
      return { model: [id, 0], clip: [id, 1], via: classType };
    }
  }
  let model = null;
  let clip = null;
  for (const node of Object.values(graph ?? {})) {
    for (const [input, value] of Object.entries(node?.inputs ?? {})) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const ref = [String(value[0]), Number(value[1]) || 0];
      if (input === 'model' && !model) model = ref;
      if (!clip && /^clip\d*$/i.test(input)) clip = ref;
    }
  }
  return { model, clip, via: 'inferred' };
}

/** 把所有等于 from 的连线改成指向 to（跳过 skip 里的节点，别把 LoRA 链自己改了）。 */
function rewire(graph, from, to, skip = new Set()) {
  if (!from || !to) return 0;
  let changed = 0;
  for (const [id, node] of Object.entries(graph ?? {})) {
    if (skip.has(String(id))) continue;
    const inputs = node?.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    for (const [key, value] of Object.entries(inputs)) {
      if (!Array.isArray(value) || value.length < 2) continue;
      if (String(value[0]) === String(from[0]) && (Number(value[1]) || 0) === (Number(from[1]) || 0)) {
        inputs[key] = to;
        changed += 1;
      }
    }
  }
  return changed;
}

/**
 * 往工作流里注入 LoRA。
 *
 * ComfyUI 的 LoRA 不是请求参数，而是图里的一个节点 —— 所以这里做的是"插节点 + 改连线"：
 *   1) 找到 MODEL / CLIP 的源头；
 *   2) 按顺序串一串 LoraLoader（第一个接源头，往后依次接）；
 *   3) 把原来引用源头的地方，全改指向链尾（VAE 不动）。
 * 触发词（如果有）接在正向提示词后面。找不到源头就如实报出来，不做半吊子修改。
 */
export function applyLoras(prompt, loras = [], { appendTriggers = true } = {}) {
  const list = normaliseLoras(loras).filter((item) => item.enabled);
  const warnings = [];
  if (!list.length) return { prompt, injected: [], triggers: [], warnings };

  const graph = prompt ?? {};
  const sources = findLoraSources(graph);
  if (!sources.model) {
    warnings.push(
      '这个工作流里找不到「模型来源」节点（一般是 CheckpointLoaderSimple），LoRA 没插进去。'
        + '要么换成带 checkpoint 加载器的工作流，要么在 ComfyUI 里手动加一个 LoraLoader。',
    );
    return { prompt, injected: [], triggers: [], warnings };
  }
  if (!sources.clip) warnings.push('没找到 CLIP 来源，LoRA 只接在模型上，效果可能打折。');

  const used = new Set(Object.keys(graph).map(String));
  const nextId = () => {
    let n = used.size + 1;
    while (used.has(String(n))) n += 1;
    used.add(String(n));
    return String(n);
  };

  const ids = list.map(() => nextId());
  const injected = list.map((item, index) => ({ id: ids[index], ...item }));
  const tailId = ids[ids.length - 1];
  const skip = new Set(ids);

  // 先改线（把"原来指向源头"的改指向链尾），再插节点、把链首接回源头
  rewire(graph, sources.model, [tailId, 0], skip);
  if (sources.clip) rewire(graph, sources.clip, [tailId, 1], skip);

  injected.forEach((item, index) => {
    const prevModel = index === 0 ? sources.model : [ids[index - 1], 0];
    const prevClip = index === 0 ? sources.clip ?? sources.model : [ids[index - 1], 1];
    graph[item.id] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: item.name,
        strength_model: item.strengthModel,
        strength_clip: item.strengthClip,
        model: prevModel,
        clip: prevClip,
      },
    };
  });

  const triggers = [];
  if (appendTriggers) {
    for (const item of list) if (item.trigger) triggers.push(item.trigger);
    if (triggers.length) {
      const slot = detectPromptSlots(graph)?.positive ?? null;
      const node = slot ? graph[slot.nodeId] : null;
      if (slot && node?.inputs && slot.input in node.inputs) {
        node.inputs[slot.input] = tidyPrompt([String(node.inputs[slot.input] ?? ''), ...triggers].join(', '));
      } else {
        warnings.push('找不到正向提示词节点，LoRA 的触发词没接上去（LoRA 本身已经加载）。');
      }
    }
  }

  return { prompt: graph, injected, triggers, warnings };
}

// ---------------------------------------------------------------- 衣柜（换装）

/** 收一收衣柜：每套要个名字，最多 30 套。 */
export function normaliseOutfits(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item, index) => ({
      id: String(item?.id ?? `outfit-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `outfit-${index + 1}`,
      name: String(item?.name ?? '').trim().slice(0, 40) || `套装 ${index + 1}`,
      prompt: String(item?.prompt ?? '').trim().slice(0, 1000),
      negative: String(item?.negative ?? '').trim().slice(0, 1000),
    }))
    .slice(0, 30);
}

/** 现在穿的是哪套：按 activeId 找，找不到就用第一套；一套都没有返回 null。 */
export function activeOutfit(outfits = [], activeId = null) {
  const list = normaliseOutfits(outfits);
  return list.find((item) => item.id === activeId) ?? list[0] ?? null;
}

/** 把一段负向词接到工作流的负向提示词后面（角色专属负面词）。找不到负向槽就如实返回 false。 */
export function appendNegativePrompt(prompt, text) {
  const clean = String(text ?? '').trim();
  if (!clean) return { prompt, appended: false };
  const slot = detectPromptSlots(prompt)?.negative ?? null;
  const node = slot ? prompt?.[slot.nodeId] : null;
  if (!slot || !node?.inputs || !(slot.input in node.inputs)) return { prompt, appended: false };
  node.inputs[slot.input] = tidyPrompt([String(node.inputs[slot.input] ?? ''), clean].join(', '));
  return { prompt, appended: true };
}

/**
 * 剧情换装：`[换装: 泳装]` / `[OUTFIT: swimsuit]`。
 * AI 在回复里写这个标记，就把它身上那套换成衣柜里的另一套 —— 跟 `[IMG:]` 一个路子，
 * 做 galgame 时"剧情推进到换衣服了"就不用你去点。
 */
export const OUTFIT_MARKER_RE = /\[(?:换装|OUTFIT)\s*[:：]\s*([^\]]*)\]/gi;

export function parseOutfitMarkers(text) {
  const out = [];
  const re = new RegExp(OUTFIT_MARKER_RE.source, 'gi');
  let match;
  while ((match = re.exec(String(text ?? ''))) !== null) {
    const name = String(match[1] ?? '').trim();
    if (name) out.push({ name, raw: match[0] });
  }
  return out;
}

/** `[IMG: portrait: 一只白狐，雪夜]` 这种标记 → 出图请求。 */
export const IMAGE_MARKER_RE = /\[IMG:\s*([^\]]*)\]/gi;

export function parseImageMarkers(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(IMAGE_MARKER_RE)) {
    const inner = match[1].trim();
    if (!inner) continue;
    let kind = null;
    let prompt = inner;
    const colon = inner.indexOf(':');
    if (colon > 0) {
      const head = inner.slice(0, colon).trim().toLowerCase();
      if (COMFY_WORKFLOW_KINDS.some((item) => item.id === head)) {
        kind = head;
        prompt = inner.slice(colon + 1).trim();
      }
    }
    out.push({ raw: match[0], kind, prompt });
  }
  return out;
}

/**
 * 该不该为这一轮出图。
 *   manual —— 从不出（只有界面上手点）
 *   marker —— 回复里有 [IMG: ...] 才出
 *   auto   —— 场景变化（```state 里有 place / 属性变化）就出
 * 这是纯判断，方便单测；真正的提交在 server/toolbox/runner.mjs。
 */
export function planImageTrigger({ mode = 'manual', content = '', stateDelta = null, kind = 'normal', workflowId = null } = {}) {
  if (kind === 'impersonate' || kind === 'options') return { trigger: false, reason: '这一轮不是我方回复' };
  if (mode === 'manual') return { trigger: false, reason: '手动模式：只有界面上点"出一张图"才出图' };
  const markers = parseImageMarkers(content);
  if (markers.length) {
    return { trigger: true, reason: '命中 [IMG:] 标记', requests: markers.map((item) => ({ kind: item.kind, prompt: item.prompt, workflowId })) };
  }
  if (mode !== 'auto') return { trigger: false, reason: '没有 [IMG:] 标记' };
  const changed = stateDelta && typeof stateDelta === 'object'
    ? ['place', 'time'].filter((key) => stateDelta[key] !== undefined && stateDelta[key] !== null && String(stateDelta[key]).trim() !== '')
    : [];
  if (!changed.length) return { trigger: false, reason: '这一轮场景没变化' };
  return { trigger: true, reason: `场景变化：${changed.join(' / ')}`, requests: [{ kind: 'background', prompt: '', workflowId }] };
}

// ------------------------------------------------------------------ 加分项：表情差分批量 / 角色绑定 / 参考图

/**
 * 表情差分批量：一次把几个表情都出了。
 * 只给"表情关键词 + 标签"，具体把关键词接到哪个文本参数上由服务层决定
 * （和 marker 触发接提示词是一个路子，保证工作流里那串角色 LoRA 触发词不被冲掉）。
 */
export const EXPRESSION_PRESETS = [
  { id: 'neutral', label: '平静', keywords: 'calm expression, neutral face' },
  { id: 'happy', label: '开心', keywords: 'happy, smiling, cheerful, open mouth' },
  { id: 'sad', label: '难过', keywords: 'sad, crying, teary eyes, downturned mouth' },
  { id: 'angry', label: '生气', keywords: 'angry, frowning, annoyed, furrowed brow' },
  { id: 'shy', label: '害羞', keywords: 'shy, blushing, embarrassed, looking away' },
  { id: 'surprised', label: '惊讶', keywords: 'surprised, wide eyes, shocked, raised eyebrows' },
];

export function listExpressions() {
  return EXPRESSION_PRESETS.map((item) => ({ ...item }));
}

export function getExpression(id) {
  return EXPRESSION_PRESETS.find((item) => item.id === id) ?? null;
}

/** 默认批量四个：开心 / 难过 / 生气 / 害羞。 */
export const DEFAULT_BATCH_EMOTIONS = ['happy', 'sad', 'angry', 'shy'];

export function planExpressionBatch({ emotions = null, baseText = '' } = {}) {
  const requested = Array.isArray(emotions) && emotions.length ? emotions : DEFAULT_BATCH_EMOTIONS;
  const seen = new Set();
  return requested
    .map((id) => getExpression(typeof id === 'string' ? id : id?.id))
    .filter((item) => item && !seen.has(item.id) && (seen.add(item.id), true))
    .map((item) => ({
      emotion: item.id,
      label: item.label,
      keywords: item.keywords,
      text: [String(baseText ?? '').trim(), item.keywords].filter(Boolean).join(', '),
    }));
}

// 队列 / WS 事件 / history / 地址与错误翻译在 web/core/comfy-events.mjs 里实现 ——
// 服务端 runner 与浏览器直连共用同一份，不重写第二套。这里原样再导出，
// core 侧原有的 import 路径不变。
export {
  ASSET_REF_PREFIX,
  COMFY_EXECUTION_MODES,
  COMFY_TERMINAL_STATUSES,
  applyAssetRefs,
  collectAssetRefs,
  collectHistoryImages,
  comfyErrorMessage,
  comfyWsUrl,
  describeFetchError,
  getComfyExecutionMode,
  guessMime,
  historyStatus,
  isAssetRef,
  isComfyTerminal,
  makeAssetRef,
  mapComfyEvent,
  normaliseBaseUrl,
  progressPercent,
  readAssetRef,
  summariseQueue,
};
