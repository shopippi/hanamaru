import type { EmailTransport } from '../domain/notify.js';

// Resend でメールを送る（NT-03 の送信手段の1つ。8.2 で選定）。
// 依存ライブラリは足さず、Resend の HTTP API を直接呼ぶ。API キーは環境変数から渡し、リポジトリには入れない（7.2）。

const ENDPOINT = 'https://api.resend.com/emails';

export interface ResendOptions {
  apiKey: string;
  /** 送信元。例: 「はなまる音楽教室 <no-reply@send.hanamarumusic.com>」。Resend で確認済みのドメインに限る */
  from: string;
  /** 返信先。例: info@hanamarumusic.com（Cloudflare Email Routing で Gmail に転送） */
  replyTo?: string;
  /** 応答を待つ時間（ミリ秒） */
  timeoutMs?: number;
  /** テストで差し替える */
  fetch?: typeof fetch;
}

export class ResendEmailTransport implements EmailTransport {
  constructor(private readonly opts: ResendOptions) {}

  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.opts.from,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
          ...(this.opts.replyTo ? { reply_to: this.opts.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (e) {
      // 通信の失敗・時間切れ。通知は「失敗」として記録され、あとで自動で送り直す（OP-06）
      throw new Error(`メール送信サービスにつながりませんでした（${e instanceof Error ? e.name : '不明'}）`);
    }
    if (!res.ok) {
      // API キーは文言に含めない。Resend の説明（message）だけを残す
      let detail = '';
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === 'string') detail = `: ${body.message.slice(0, 200)}`;
      } catch {
        // 本文が JSON でなくても、状態コードだけで記録する
      }
      throw new Error(`メール送信サービスが受け付けませんでした（${res.status}${detail}）`);
    }
  }
}
