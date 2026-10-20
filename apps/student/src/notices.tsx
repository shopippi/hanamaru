import { useEffect, useState } from 'react';
import { Button, IconPlus, Notice, Warning } from '@hanamaru/ui';

// アプリ内ブラウザの案内（MB-05）と、ホーム画面への追加の案内（PW-03、MB-06）

/** Instagram・LINE などのアプリ内ブラウザ。Apple Pay や PayPay への切り替えが失敗することがある */
export function isInAppBrowser(ua = navigator.userAgent): boolean {
  return /Instagram|FBAN|FBAV|FB_IAB|Line\/|MicroMessenger|BytedanceWebview|musical_ly|Twitter/i.test(ua);
}

export function InAppBrowserNotice() {
  if (!isInAppBrowser()) return null;
  return (
    <Warning title="SafariまたはChromeで開いてください">
      アプリの中のブラウザでは、お支払い（Apple Pay・PayPay など）がうまくいかないことがあります。右上のメニューから「ブラウザで開く」を選んでください。
    </Warning>
  );
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

type InstallPrompt = Event & { prompt: () => Promise<void> };
const DISMISS_KEY = 'hanamaru.addToHome.dismissed';

/** 追加済み（ホーム画面から開いている）なら出さない */
export function AddToHomeGuide() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    // 追加が済んだら、その場で案内を消す
    const onInstalled = () => setDismissed(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  if (isStandalone() || dismissed || isInAppBrowser()) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // 保存できなくても動く
    }
  };
  return (
    <Notice icon={<IconPlus />}>
      <div className="stack">
        <p>
          <strong>ホーム画面に追加すると、アプリのようにすぐ開けます。</strong>
        </p>
        {isIos() ? (
          <ol style={{ margin: 0, paddingLeft: '1.2em' }}>
            <li>Safari の下にある共有ボタン（四角から矢印が出たマーク）を押す</li>
            <li>「ホーム画面に追加」を選ぶ</li>
            <li>右上の「追加」を押す</li>
          </ol>
        ) : prompt ? (
          <Button variant="secondary" onClick={() => void prompt.prompt().then(() => setPrompt(null))}>
            ホーム画面に追加
          </Button>
        ) : (
          <p>Chrome の右上のメニュー（︙）から「ホーム画面に追加」を選んでください。</p>
        )}
        {isIos() && <p className="small muted">iPhone では、ホーム画面から初めて開いたときにもう一度ログインが必要です。</p>}
        <Button variant="ghost" onClick={dismiss}>
          今は追加しない
        </Button>
      </div>
    </Notice>
  );
}
