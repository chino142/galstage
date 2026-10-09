/**
 * 统一错误类型。
 *
 * 约定：凡是能传到 HTTP 层的错误，都带一个机器可读的 code 和 http status，
 * 前端据此决定是弹提示、显示空状态还是整页报错。
 */

export class TavernError extends Error {
  constructor(message, { code = 'TAVERN_ERROR', status = 500, details = null, cause = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export class NotImplementedError extends TavernError {
  constructor(what, details = null) {
    super(`尚未实现：${what}`, { code: 'NOT_IMPLEMENTED', status: 501, details });
    this.what = what;
  }
}

export class ValidationError extends TavernError {
  constructor(message, details = null) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, details });
  }
}

export class NotFoundError extends TavernError {
  constructor(what, details = null) {
    super(`找不到：${what}`, { code: 'NOT_FOUND', status: 404, details });
  }
}

export class ConflictError extends TavernError {
  constructor(message, details = null) {
    super(message, { code: 'CONFLICT', status: 409, details });
  }
}

/** 模型 / 图片 / 语音等外部服务返回的错误。 */
export class ProviderError extends TavernError {
  constructor(message, details = null) {
    super(message, { code: 'PROVIDER_ERROR', status: 502, details });
  }
}

export function isTavernError(err) {
  return err instanceof TavernError;
}

/**
 * 造一个"还没实现"的桩函数。
 * 用法：service.list = notImplemented('角色卡列表');
 */
export function notImplemented(what) {
  return () => {
    throw new NotImplementedError(what);
  };
}

/** 接口本身是 async 的地方用这个，保证调用方拿到的是 rejected promise。 */
export function asyncNotImplemented(what) {
  return async () => {
    throw new NotImplementedError(what);
  };
}

/** 把任意异常整理成可以写进响应的结构。 */
export function toErrorPayload(err) {
  if (isTavernError(err)) return { status: err.status, body: err.toJSON() };
  const message = err && err.message ? err.message : String(err);
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message, details: null } } };
}
