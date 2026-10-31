import { eq } from 'drizzle-orm';
import { notifications } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { getSettings, type NotificationType } from './settings.js';

/** 止めるとログインできなくなる通知。設定で「送らない」にしていても送る（NT-02 の例外） */
export const ALWAYS_SENT: readonly NotificationType[] = ['invite', 'password_reset', 'system_alert'];

/**
 * 送信記録（notifications）とバックアップに、招待・再設定のリンクを残さない。
 * リンクを知っている人は、そのアカウントのパスワードを設定できてしまうため
 */
export const redactSecrets = (text: string) => text.replace(/([?&]token=)[^\s&]+/g, '$1（記録しません）');

// 通知（3.6）。送信手段（Channel）を差し替えられる作りにする（NT-03）。
// 新しい手段（LINE、ホーム画面アプリのプッシュ通知など）は Channel を1つ実装して channels に足すだけで送れる。

export interface Recipient {
  email: string | null;
  lineUserId?: string | null;
}

export interface Message {
  subject: string;
  body: string;
}

export interface Channel {
  readonly name: string;
  /** この手段での宛先。届け先がなければ null（その手段では送らない） */
  address(recipient: Recipient): string | null;
  deliver(address: string, message: Message): Promise<void>;
}

export interface Notifier {
  send(type: NotificationType, recipient: Recipient, message: Message): Promise<void>;
  /** 送れなかった通知を、記録した内容でもう一度送る（OP-06）。送れたら true */
  retry(notificationId: string): Promise<boolean>;
}

/** 記録の本文から招待・再設定のリンクを消した通知。記録から送り直してもリンクが使えないので、自動では送り直さない */
export const isRedacted = (body: string) => body.includes('（記録しません）');

export class NotificationService implements Notifier {
  constructor(
    private readonly db: Db,
    private readonly channels: Channel[],
    /** 業務の「今」（テストでは時計を動かす）。送り直しの予定時刻に使う */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 失敗したときの、次に送り直す時刻。設定の回数を使い切ったら null（あきらめる） */
  private async nextRetry(attempts: number, body: string): Promise<Date | null> {
    if (isRedacted(body)) return null;
    const { notificationRetryMinutes } = await getSettings(this.db);
    const wait = notificationRetryMinutes[attempts - 1];
    return wait === undefined ? null : new Date(this.now().getTime() + wait * 60_000);
  }

  async retry(notificationId: string): Promise<boolean> {
    const [row] = await this.db.select().from(notifications).where(eqId(notificationId));
    if (!row) return false;
    const channel = this.channels.find((c) => c.name === row.channel);
    const attempts = row.attempts + 1;
    try {
      if (!channel) throw new Error(`送信手段（${row.channel}）が使えません`);
      await channel.deliver(row.recipient, { subject: row.subject, body: row.body });
      await this.db
        .update(notifications)
        .set({ status: 'sent', sentAt: this.now(), attempts, nextRetryAt: null, error: null })
        .where(eqId(row.id));
      return true;
    } catch (e) {
      await this.db
        .update(notifications)
        .set({ status: 'failed', attempts, nextRetryAt: await this.nextRetry(attempts, row.body), error: e instanceof Error ? e.message : String(e) })
        .where(eqId(row.id));
      return false;
    }
  }

  async send(type: NotificationType, recipient: Recipient, message: Message): Promise<void> {
    const settings = await getSettings(this.db);
    const enabled = ALWAYS_SENT.includes(type) || settings.notifications[type] !== false; // NT-02
    for (const channel of this.channels) {
      const address = channel.address(recipient);
      if (!address) continue;
      const [row] = await this.db
        .insert(notifications)
        .values({
          channel: channel.name,
          type,
          recipient: address,
          subject: message.subject,
          body: redactSecrets(message.body),
          status: enabled ? 'pending' : 'skipped',
          createdAt: this.now(),
        })
        .returning({ id: notifications.id });
      if (!enabled || !row) continue;
      try {
        await channel.deliver(address, message);
        await this.db.update(notifications).set({ status: 'sent', sentAt: this.now(), attempts: 1 }).where(eqId(row.id));
      } catch (e) {
        // 通知の失敗で予約や決済の処理を止めない。記録を残し、少し待ってから送り直す（OP-06）
        const body = redactSecrets(message.body);
        await this.db
          .update(notifications)
          .set({ status: 'failed', attempts: 1, nextRetryAt: await this.nextRetry(1, body), error: e instanceof Error ? e.message : String(e) })
          .where(eqId(row.id));
      }
    }
  }
}

const eqId = (id: string) => eq(notifications.id, id);

// --- メール -----------------------------------------------------------------

export interface EmailTransport {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

export class EmailChannel implements Channel {
  readonly name = 'email';
  constructor(private readonly transport: EmailTransport) {}
  address(recipient: Recipient): string | null {
    return recipient.email;
  }
  async deliver(address: string, message: Message): Promise<void> {
    await this.transport.send({ to: address, subject: message.subject, text: message.body });
  }
}

/** 開発・検証用: 送らずに標準出力へ書く。本番のメール送信サービスは未選定（8.2） */
export class ConsoleEmailTransport implements EmailTransport {
  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    console.log(`[mail] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
  }
}

/** テスト用: 送ったメールを配列に貯める。failing を true にすると送信に失敗する */
export class MemoryEmailTransport implements EmailTransport {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  failing = false;
  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    if (this.failing) throw new Error('メールを送れませんでした（テスト）');
    this.sent.push(mail);
  }
}
