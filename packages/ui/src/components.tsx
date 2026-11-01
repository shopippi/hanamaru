import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { LoadState } from './hooks.js';
import { useOnline } from './hooks.js';
import { OFFLINE_MESSAGE } from './api.js';
import { dateParts } from './format.js';
import { IconAlert, IconCheckCircle, IconChevronLeft, IconInbox, IconInfo, IconWifiOff } from './icons.js';

// 3つのロールで共通の部品（UI-06）

// --- ボタン ---------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'quiet';
  block?: boolean;
  /** 処理中は押せなくし、処理中の表示を出す（UI-13） */
  pending?: boolean;
  pendingLabel?: string;
};

export function Button({ variant = 'primary', block, pending, pendingLabel = '処理中…', className, children, disabled, ...rest }: ButtonProps) {
  const cls = ['btn', `btn-${variant}`, block ? 'btn-block' : '', className ?? ''].join(' ').trim();
  return (
    <button type="button" className={cls} disabled={disabled || pending} aria-busy={pending || undefined} {...rest}>
      {pending ? (
        <>
          <span className="spinner" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

// --- 入力欄（UI-16、UI-17、UI-19） ------------------------------------------

type FieldShell = { label: string; hint?: string; error?: string | undefined };

function Shell({ id, label, hint, error, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {children}
      {error && (
        <span className="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

const described = (id: string, hint?: string, error?: string) =>
  [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;

export function TextField({ label, hint, error, ...rest }: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <input id={id} className="input" aria-invalid={error ? true : undefined} aria-describedby={described(id, hint, error)} {...rest} />
    </Shell>
  );
}

export function TextArea({ label, hint, error, ...rest }: FieldShell & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <textarea id={id} className="textarea" aria-invalid={error ? true : undefined} aria-describedby={described(id, hint, error)} {...rest} />
    </Shell>
  );
}

export function Select({ label, hint, error, children, ...rest }: FieldShell & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <select id={id} className="select" aria-invalid={error ? true : undefined} aria-describedby={described(id, hint, error)} {...rest}>
        {children}
      </select>
    </Shell>
  );
}

export function Checkbox({ label, ...rest }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}

// --- 読み込み中・失敗・0件（UI-07〜12） ------------------------------------

/** 完成後と同じ配置・大きさの枠（UI-07） */
export function Skeleton({ lines = 1, block, width }: { lines?: number; block?: boolean; width?: string }) {
  if (block) return <div className="skeleton skeleton-block" aria-hidden="true" />;
  return (
    <div aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton skeleton-line" style={{ width: i === lines - 1 && lines > 1 ? '60%' : (width ?? '100%') }} />
      ))}
    </div>
  );
}

/**
 * 読み込みの状態に応じて、スケルトン・失敗の表示・中身を出し分ける。
 * skeleton は完成後の画面と同じ大きさにする（画面がガタッと動かない）。
 */
export function Loadable<T>({
  state,
  reload,
  skeleton,
  children,
}: {
  state: LoadState<T>;
  reload: () => void;
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.kind === 'ready') return <>{children(state.data)}</>;
  if (state.kind === 'error') return <LoadError message={state.message} onRetry={reload} />;
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">読み込み中</span>
      {/* 0.3秒未満は透明にしてちらつきを防ぐ（UI-10）。場所だけは確保する */}
      <div style={{ visibility: state.kind === 'idle' ? 'hidden' : 'visible' }}>{skeleton}</div>
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="notice warning" role="alert">
      <span className="notice-icon" aria-hidden="true">
        <IconAlert />
      </span>
      <div className="notice-body stack-sm">
        <p>
          <strong>{message === '読み込めませんでした' ? message : `読み込めませんでした（${message}）`}</strong>
        </p>
        <div>
          <Button variant="secondary" onClick={onRetry}>
            再読み込み
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 0件のときは空白にせず、理由と次の操作を出す（UI-12） */
export function Empty({ message, text, action, icon }: { message: string; text?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        {icon ?? <IconInbox />}
      </span>
      <p className="empty-title">{message}</p>
      {text && <p className="empty-text">{text}</p>}
      {action}
    </div>
  );
}

// --- 案内・警告（UI-02） ------------------------------------------------------

export function Notice({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="notice" role="note">
      <span className="notice-icon" aria-hidden="true">
        {icon ?? <IconInfo />}
      </span>
      <div className="notice-body">{children}</div>
    </div>
  );
}

/** 強い警告。色に頼らず、太い黒枠・警告アイコン・太字で目立たせる */
export function Warning({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="notice warning" role="alert">
      <span className="notice-icon" aria-hidden="true">
        {icon ?? <IconAlert />}
      </span>
      <div className="notice-body">
        <p>
          <strong>{title}</strong>
        </p>
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

// --- トースト（UI-14） --------------------------------------------------------

type Toast = { id: number; message: string; kind: 'success' | 'error' };
const ToastContext = createContext<(message: string, kind?: Toast['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const show = useCallback((message: string, kind: Toast['kind'] = 'success') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'toast-error' : ''}`}>
            {t.kind === 'error' ? <IconAlert size={18} /> : <IconCheckCircle size={18} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// --- 確認画面（UI-15） --------------------------------------------------------

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'やめる',
  pending,
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  pending?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onCancel={(e) => (e.preventDefault(), !pending && onCancel())}>
      <div className="dialog-body">
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="dialog-actions">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button onClick={onConfirm} pending={pending} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

// --- オフライン（PW-04） ---------------------------------------------------------

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <Warning title={OFFLINE_MESSAGE} icon={<IconWifiOff />}>
      予約やキャンセルは、電波のある場所で開き直してから行ってください。
    </Warning>
  );
}

/** オフラインのときは押せないボタン */
export function OnlineButton(props: Parameters<typeof Button>[0]) {
  const online = useOnline();
  return <Button {...props} disabled={props.disabled || !online} />;
}

// --- ページの見出し・区切り --------------------------------------------------------

/** ページの見出し。右側に主な操作を置く */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string; as?: (p: { to: string; className: string; children: ReactNode }) => ReactNode };
}) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        {back &&
          (back.as ? (
            back.as({ to: back.to, className: 'back', children: <><IconChevronLeft size={16} />{back.label}</> })
          ) : (
            <a className="back" href={back.to}>
              <IconChevronLeft size={16} />
              {back.label}
            </a>
          ))}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

/** 枠で囲んだまとまり。見出しと右側の操作を持てる */
export function Panel({
  title,
  actions,
  children,
  flush,
  footer,
  id,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  footer?: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section className={['panel', className ?? ''].join(' ').trim()} id={id}>
      {(title || actions) && (
        <div className="panel-header">
          {title && <h2>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
      {footer && <div className="panel-footer">{footer}</div>}
    </section>
  );
}

/** 2〜4個から1つを選ぶ切り替え */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([k, text]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** 数字を大きく見せる枠（ダッシュボード） */
export function Stat({ label, value, unit, hint }: { label: string; value: ReactNode; unit?: string; hint?: ReactNode }) {
  return (
    <>
      <p className="stat-label">{label}</p>
      <p className="stat-value num">
        {value}
        {unit && <small>{unit}</small>}
      </p>
      {hint && <p className="small muted">{hint}</p>}
    </>
  );
}

/** カレンダーの1日の形の日付（読み上げは隣の文字で伝える） */
export function DateTile({ at }: { at: Date | string }) {
  const p = dateParts(at);
  return (
    <span className="date-tile" aria-hidden="true">
      <span className="date-tile-month">{p.month}月</span>
      <span className="date-tile-day">{p.day}</span>
      <span className="date-tile-weekday">{p.weekday}</span>
    </span>
  );
}

/**
 * 横に広い表の入れ物。スマホでは横に送れるので、キーボードでもたどり着けるようにし、
 * 読み上げで何の表かが分かるように名前を付ける（UI-19、WCAG 2.1.1）
 */
export function TableWrap({ label, flush, children }: { label: string; flush?: boolean; children: ReactNode }) {
  return (
    <div className={flush ? 'table-wrap flush' : 'table-wrap'} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
