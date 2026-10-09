/**
 * 视觉：把图片变成模型能消化的东西。
 *
 * 两条路，按模型能力自动选：能看图的模型直接把图按各家格式拼进消息
 * （OpenAI 是 image_url、Anthropic 是 base64 source、Gemini 是 inlineData）；
 * 不能看图的模型先用看图模型写一段描述，再按模板塞进对话。
 * 后者就是酒馆那条 Image Captioning 扩展在做的事。
 */

import { ValidationError } from '../errors.mjs';

export const CAPTION_TEMPLATE_DEFAULT = '[{{user}} 发给 {{char}} 一张图片，内容是：{{caption}}]';

export const SUPPORTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

/** 单张图上限：多数服务商是 5–20MB，取中间偏安全的值。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function normaliseImageMeta(input = {}) {
  const mime = String(input.mime ?? '').toLowerCase();
  if (!SUPPORTED_IMAGE_MIMES.includes(mime)) {
    throw new ValidationError(`不支持的图片格式：${mime || '(空)'}（支持 ${SUPPORTED_IMAGE_MIMES.join(' / ')}）`);
  }
  const bytes = Number(input.bytes ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) throw new ValidationError('图片大小不合法');
  if (bytes > MAX_IMAGE_BYTES) {
    throw new ValidationError(`图片 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
  }
  return { mime, bytes, base64: String(input.base64 ?? ''), name: String(input.name ?? '') };
}

export function renderCaption(template = CAPTION_TEMPLATE_DEFAULT, { caption = '', user = 'User', char = '角色' } = {}) {
  return String(template || CAPTION_TEMPLATE_DEFAULT)
    .split('{{caption}}').join(String(caption ?? '').trim())
    .split('{{user}}').join(String(user))
    .split('{{char}}').join(String(char));
}

/** 这一轮该走哪条路。 */
export function decideImageMode({ hasImages = false, providerSupportsVision = false, captionModelAvailable = false } = {}) {
  if (!hasImages) return { mode: 'off', reason: '这一轮没有图' };
  if (providerSupportsVision) return { mode: 'vision', reason: '当前模型能直接看图' };
  if (captionModelAvailable) return { mode: 'caption', reason: '当前模型不能看图，先用看图模型转成文字' };
  return { mode: 'off', reason: '当前模型既不能看图，也没配看图模型；这一轮不发图' };
}

// ---------------------------------------------------------------- 各家格式

export function toOpenAIContent(text, images = []) {
  const list = (Array.isArray(images) ? images : []).filter(Boolean);
  if (!list.length) return String(text ?? '');
  return [
    ...(text ? [{ type: 'text', text: String(text) }] : []),
    ...list.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    })),
  ];
}

export function toAnthropicContent(text, images = []) {
  const list = (Array.isArray(images) ? images : []).filter(Boolean);
  if (!list.length) return String(text ?? '');
  return [
    ...list.map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mime, data: image.base64 },
    })),
    ...(text ? [{ type: 'text', text: String(text) }] : []),
  ];
}

export function toGeminiParts(text, images = []) {
  const list = (Array.isArray(images) ? images : []).filter(Boolean);
  return [
    ...list.map((image) => ({ inlineData: { mimeType: image.mime, data: image.base64 } })),
    ...(text ? [{ text: String(text) }] : []),
  ];
}

/** 把带 images 的消息按适配器转格式；没有图的条目原样返回。 */
export function applyImagesToMessages(messages = [], adapter = 'openai') {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const images = Array.isArray(message?.images) ? message.images : [];
    const text = String(message?.content ?? '');
    if (!images.length) {
      const { images: _ignored, ...rest } = message ?? {};
      return { ...rest, content: text };
    }
    if (adapter === 'anthropic') return { role: message.role, content: toAnthropicContent(text, images), name: message.name };
    return { role: message.role, content: toOpenAIContent(text, images), name: message.name };
  });
}
