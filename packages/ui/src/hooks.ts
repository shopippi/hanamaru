import { useCallback, useEffect, useRef, useState } from 'react';

/** 読み込み中の表示の決まり（UI-10、UI-11） */
export const SKELETON_DELAY_MS = 300;
export const LOAD_TIMEOUT_MS = 10_000;

export type LoadState<T> =
  | { kind: 'idle' } // 0.3秒未満はまだ何も出さない（ちらつき防止）
  | { kind: 'loading' } // スケルトンを出す
  | { kind: 'ready'; data: T }
  | { kind: 'error'; message: string }; // 失敗・10秒たっても届かない

/**
 * データを読み込む。読み込みが0.3秒未満で終わればスケルトンを出さず、
 * 失敗したときや10秒たっても届かないときは「読み込めませんでした」にする。
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<LoadState<T>>({ kind: 'idle' });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let done = false;
    let cancelled = false;
    setState((s) => (s.kind === 'ready' ? s : { kind: 'idle' }));
    const delay = setTimeout(() => !done && setState((s) => (s.kind === 'ready' ? s : { kind: 'loading' })), SKELETON_DELAY_MS);
    const timeout = setTimeout(() => {
      if (!done && !cancelled) setState({ kind: 'error', message: '読み込めませんでした' });
    }, LOAD_TIMEOUT_MS);
    loadRef
      .current()
      .then((data) => {
        done = true;
        if (!cancelled) setState({ kind: 'ready', data });
      })
      .catch((e: unknown) => {
        done = true;
        if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : '読み込めませんでした' });
      })
      .finally(() => {
        clearTimeout(delay);
        clearTimeout(timeout);
      });
    return () => {
      cancelled = true;
      clearTimeout(delay);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { state, reload, data: state.kind === 'ready' ? state.data : undefined };
}

/** 押した直後に押せなくし、処理中を表示する（UI-13） */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      if (busy.current) return undefined;
      busy.current = true;
      setPending(true);
      try {
        return await fn(...args);
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [fn],
  );
  return { run, pending };
}

/** 電波の有無（PW-04） */
export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
