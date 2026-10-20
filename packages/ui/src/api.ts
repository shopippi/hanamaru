// API の呼び出し。どのポータルでも同じ形で使う（UI-06）

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | undefined,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 通信できなかったとき（PW-04） */
export const OFFLINE_MESSAGE = 'オフラインです。電波のある場所で開き直してください';

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

/**
 * base は各サブドメインの /api。ログインが切れていたら onLoginRequired を呼ぶ（ST-06）。
 */
export function createApi(base: string, opts: { onLoginRequired?: (code: string) => void } = {}): Api {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, navigator.onLine === false ? OFFLINE_MESSAGE : '通信できませんでした。時間をおいてもう一度お試しください', 'network');
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = (data ?? {}) as { error?: string; code?: string; details?: unknown };
      if (res.status === 401 && (err.code === 'login_required' || err.code === 'mfa_required')) {
        opts.onLoginRequired?.(err.code);
      }
      throw new ApiError(res.status, err.error ?? 'エラーが発生しました', err.code, err.details);
    }
    return data as T;
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}

/** 入力の誤りを欄ごとに分ける（UI-16）。zod の issues の path[0] を欄の名前とみなす */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const issue of e.details as { path?: (string | number)[]; message?: string }[]) {
    const key = issue.path?.[0];
    if (typeof key === 'string' && issue.message && !out[key]) out[key] = issue.message;
  }
  return out;
}
