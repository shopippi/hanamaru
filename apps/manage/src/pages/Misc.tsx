import { useState } from 'react';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Empty,
  IconBan,
  IconHistory,
  IconMail,
  IconPhone,
  IconPlus,
  IconSparkle,
  Loadable,
  Notice,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  TextField,
  WEEKDAY_LABELS,
  dateKey,
  fmtDateKey,
  fmtDateTime,
  fmtTime,
  useAction,
  useLoad,
  useToast,
} from '@hanamaru/ui';
import { api, type LessonType, type Slot, type Teacher } from '../api.js';

// 体験の申込（TR-01）、休講（AV-04）、設定（3.8）、操作記録（OP-03）

interface TrialRequest {
  id: string;
  name: string;
  guardianName: string | null;
  email: string;
  phone: string | null;
  instrument: string | null;
  preferredTimes: string;
  message: string;
  status: 'new' | 'scheduled' | 'done' | 'cancelled';
  createdAt: string;
}
const TRIAL_STATUS = { new: '新規', scheduled: '日時確定', done: '実施済み', cancelled: '取消' };

export function Trials() {
  const toast = useToast();
  const { state, reload } = useLoad(() => Promise.all([api.get<TrialRequest[]>('/trial-requests'), api.get<Teacher[]>('/teachers'), api.get<LessonType[]>('/lesson-types')]), []);
  const [booking, setBooking] = useState<string | null>(null);
  const [teacherId, setTeacherId] = useState('');
  const [date, setDate] = useState(dateKey(new Date()));
  const slots = useLoad(() => (teacherId ? api.get<Slot[]>(`/slots?teacherId=${teacherId}&from=${date}&to=${date}`) : Promise.resolve([] as Slot[])), [teacherId, date]);
  const act = useAction(async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      setBooking(null);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作できませんでした', 'error');
    }
  });
  return (
    <div>
      <PageHeader title="体験レッスンの申込" description="申込者の希望を見て枠を押さえると、確定のメールが届きます。" />
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
        {([list, teachers, types]) =>
          list.length === 0 ? (
            <div className="panel">
              <Empty icon={<IconSparkle />} message="体験の申込はまだありません" />
            </div>
          ) : (
            <div className="panel">
            <ul className="list">
              {list.map((t) => (
                <li key={t.id} className="stack">
                  <div className="stack-sm">
                    <div className="spread">
                      <span className="row-tight" style={{ alignItems: 'center' }}>
                        <strong>{t.name}</strong>
                        <span className={t.status === 'new' ? 'badge badge-strong' : t.status === 'scheduled' ? 'badge badge-dot' : 'badge badge-muted'}>{TRIAL_STATUS[t.status]}</span>
                      </span>
                      <span className="small muted">{fmtDateTime(t.createdAt)}</span>
                    </div>
                    <p className="small secondary row-tight" style={{ alignItems: 'center', gap: 12 }}>
                      {t.guardianName && <span>保護者: {t.guardianName}</span>}
                      <a className="row-tight" style={{ alignItems: 'center' }} href={`mailto:${t.email}`}>
                        <IconMail size={14} />
                        {t.email}
                      </a>
                      {t.phone && (
                        <a className="row-tight" style={{ alignItems: 'center' }} href={`tel:${t.phone}`}>
                          <IconPhone size={14} />
                          {t.phone}
                        </a>
                      )}
                      {t.instrument && <span>{t.instrument}</span>}
                    </p>
                    {t.preferredTimes && <p className="small">希望: {t.preferredTimes}</p>}
                    {t.message && <p className="small secondary" style={{ whiteSpace: 'pre-wrap' }}>{t.message}</p>}
                  </div>
                  <div className="row">
                    {t.status === 'new' && <Button onClick={() => setBooking(booking === t.id ? null : t.id)}>枠を押さえる</Button>}
                    {t.status === 'scheduled' && (
                      <Button variant="secondary" onClick={() => void act.run(() => api.post(`/trial-requests/${t.id}/status`, { status: 'done' }), '実施済みにしました')}>
                        実施済みにする
                      </Button>
                    )}
                    {t.status !== 'cancelled' && t.status !== 'done' && (
                      <Button variant="ghost" onClick={() => void act.run(() => api.post(`/trial-requests/${t.id}/status`, { status: 'cancelled' }), '取り消しました')}>
                        取り消す
                      </Button>
                    )}
                  </div>
                  {booking === t.id && (
                    <div className="card stack">
                      <div className="grid-2">
                        <Select label="講師" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
                          <option value="">選んでください</option>
                          {teachers.filter((x) => x.active).map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </Select>
                        <TextField label="日付" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                      </div>
                      <Loadable state={slots.state} reload={slots.reload} skeleton={<Skeleton lines={2} />}>
                        {(s) => {
                          const open = s.filter((x) => x.booked < x.capacity);
                          return teacherId && open.length === 0 ? (
                            <p className="small muted">この日は空いている枠がありません</p>
                          ) : (
                            <div className="slot-grid">
                              {open.map((x) => (
                                <Button
                                  key={x.startsAt + x.lessonTypeId}
                                  variant="secondary"
                                  onClick={() =>
                                    void act.run(
                                      () => api.post(`/trial-requests/${t.id}/reservations`, { teacherId, lessonTypeId: x.lessonTypeId, startsAt: x.startsAt }),
                                      '予約しました。申込者に確定のメールを送りました',
                                    )
                                  }
                                >
                                  {fmtTime(x.startsAt)} {types.find((y) => y.id === x.lessonTypeId)?.name}
                                </Button>
                              ))}
                            </div>
                          );
                        }}
                      </Loadable>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            </div>
          )
        }
      </Loadable>
    </div>
  );
}

export function Closures() {
  const toast = useToast();
  const { state, reload } = useLoad(() => api.get<{ id: string; date: string; startTime: string | null; endTime: string | null; reason: string }[]>('/closures'), []);
  const [form, setForm] = useState({ date: '', allDay: true, startTime: '10:00', endTime: '12:00', reason: '' });
  const [confirm, setConfirm] = useState(false);
  const create = useAction(async () => {
    try {
      const r = await api.post<{ cancelled: number }>('/closures', {
        date: form.date,
        startTime: form.allDay ? null : form.startTime,
        endTime: form.allDay ? null : form.endTime,
        reason: form.reason,
      });
      toast(r.cancelled ? `休講にしました。${r.cancelled}件の予約を取り消し、回数を戻しました` : '休講にしました');
      setConfirm(false);
      reload();
    } catch (e) {
      setConfirm(false);
      toast(e instanceof Error ? e.message : '設定できませんでした', 'error');
    }
  });
  const remove = useAction(async (id: string) => {
    await api.del(`/closures/${id}`);
    toast('休講を取り消しました（取り消した予約は戻りません）');
    reload();
  });
  return (
    <div>
      <PageHeader title="休講日・臨時休講" description="休講にした時間帯の予約は取り消し、回数を生徒に戻します。" />
      <div className="stack-lg">
        <Panel
          title="休講を追加"
          footer={
            <Button onClick={() => setConfirm(true)} disabled={!form.date}>
              休講にする
            </Button>
          }
        >
          <div className="stack">
            <div className="grid-2">
              <TextField label="日付" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              <TextField label="理由" hint="例: 台風のため" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </div>
            <div className="row">
              <Checkbox label="終日" checked={form.allDay} onChange={(e) => setForm({ ...form, allDay: e.target.checked })} />
              {!form.allDay && (
                <>
                  <input aria-label="開始" type="time" step={900} className="input" style={{ width: 'auto' }} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
                  <span>〜</span>
                  <input aria-label="終了" type="time" step={900} className="input" style={{ width: 'auto' }} value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
                </>
              )}
            </div>
          </div>
        </Panel>
        <Panel title="登録済みの休講" flush>
          <Loadable state={state} reload={reload} skeleton={<div className="panel-body"><Skeleton lines={4} /></div>}>
            {(list) =>
              list.length === 0 ? (
                <Empty icon={<IconBan />} message="休講日はありません" />
              ) : (
                <ul className="list">
                  {list.map((c) => (
                    <li key={c.id} className="list-row">
                      <span className="list-row-main">
                        <span className="list-title">
                          {fmtDateKey(c.date)}　<span className="num">{c.startTime ? `${c.startTime}〜${c.endTime}` : '終日'}</span>
                        </span>
                        {c.reason && <span className="list-meta">{c.reason}</span>}
                      </span>
                      <Button variant="quiet" onClick={() => void remove.run(c.id)}>
                        削除
                      </Button>
                    </li>
                  ))}
                </ul>
              )
            }
          </Loadable>
        </Panel>
      </div>
      <ConfirmDialog open={confirm} title="休講にしますか" confirmLabel="休講にする" pending={create.pending} onCancel={() => setConfirm(false)} onConfirm={() => void create.run()}>
        <p>この時間帯の予約はすべて「教室都合のキャンセル」として取り消し、回数を生徒に戻して、メールでお知らせします。</p>
      </ConfirmDialog>
    </div>
  );
}

type Settings = {
  businessHours: ({ open: string; close: string } | null)[];
  publishWeeks: number;
  reserveDeadlineHours: number;
  changeDeadlineHours: number;
  cancelDeadlineHours: number;
  approvalRequired: boolean;
  graceDays: number;
  carryoverEnabled: boolean;
  carryoverMax: number;
  selfRegistration: boolean;
  inviteCodeRegistration: boolean;
  trialPublicSlots: boolean;
  notifications: Record<string, boolean>;
  sessionDays: number;
  maxFailedLogins: number;
  lockMinutes: number;
  resetTokenMinutes: number;
  inviteTokenDays: number;
  reminderHour: number;
};

const NOTIFY_LABEL: Record<string, string> = {
  reservation_confirmed: '予約の確定',
  reservation_changed: '予約の変更',
  reservation_cancelled: '予約のキャンセル',
  reservation_reminder: '前日リマインド',
  payment_succeeded: 'お支払いの確認',
  payment_failed: 'お支払いの失敗',
  payment_link: 'コンビニ・PayPay の支払いリンク',
  invite: '招待',
  password_reset: 'パスワード再設定',
  trial_request: '体験レッスンの申込',
};

export function SettingsPage() {
  const toast = useToast();
  const { state, reload } = useLoad(() => api.get<Settings>('/settings'), []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const save = useAction(async (s: Settings) => {
    try {
      await api.patch('/settings', s);
      toast('設定を保存しました');
      setDraft(null);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存できませんでした', 'error');
    }
  });
  return (
    <div>
      <PageHeader title="設定" description="予約・料金・通知などの運用ルールを変えられます。変更は「設定を保存する」で反映します。" />
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={14} />}>
        {(loaded) => {
          const s = draft ?? loaded;
          const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...s, [k]: v });
          const numField = (k: keyof Settings, label: string, hint?: string) => (
            <TextField label={label} hint={hint} inputMode="numeric" value={String(s[k])} onChange={(e) => set(k, Number(e.target.value.replace(/\D/g, '')) as never)} />
          );
          return (
            <div className="stack-lg">
              <Panel title="営業日・時間">
                <div className="stack">
                {s.businessHours.map((h, wd) => (
                  <div key={wd} className="row">
                    <span className="avatar avatar-sm">{WEEKDAY_LABELS[wd]}</span>
                    <Checkbox
                      label="営業"
                      checked={!!h}
                      onChange={(e) => set('businessHours', s.businessHours.map((x, i) => (i === wd ? (e.target.checked ? { open: '10:00', close: '21:00' } : null) : x)))}
                    />
                    {h && (
                      <>
                        <input aria-label={`${WEEKDAY_LABELS[wd]}曜の開始`} type="time" className="input" style={{ width: 'auto' }} value={h.open} onChange={(e) => set('businessHours', s.businessHours.map((x, i) => (i === wd ? { ...h, open: e.target.value } : x)))} />
                        <span>〜</span>
                        <input aria-label={`${WEEKDAY_LABELS[wd]}曜の終了`} type="time" className="input" style={{ width: 'auto' }} value={h.close} onChange={(e) => set('businessHours', s.businessHours.map((x, i) => (i === wd ? { ...h, close: e.target.value } : x)))} />
                      </>
                    )}
                  </div>
                ))}
                {numField('publishWeeks', '生徒に予約を公開する期間（週）')}
                </div>
              </Panel>
              <Panel title="予約のルール">
                <div className="stack">
                <div className="grid-2">
                  {numField('reserveDeadlineHours', '予約の締切（レッスンの何時間前まで）')}
                  {numField('changeDeadlineHours', '変更の締切（何時間前まで）')}
                  {numField('cancelDeadlineHours', 'キャンセルの締切（何時間前まで）', 'これより後のキャンセルは回数が戻りません')}
                </div>
                <Checkbox label="予約を管理者の承認制にする（承認まで「仮予約」）" checked={s.approvalRequired} onChange={(e) => set('approvalRequired', e.target.checked)} />
                </div>
              </Panel>
              <Panel title="料金・回数">
                <div className="stack">
                <div className="grid-2">
                  {numField('graceDays', '未払いの猶予期間（日）')}
                  {numField('carryoverMax', '翌月に繰り越せる回数の上限')}
                </div>
                <Checkbox label="余った回数を翌月に繰り越す" checked={s.carryoverEnabled} onChange={(e) => set('carryoverEnabled', e.target.checked)} />
                </div>
              </Panel>
              <Panel title="生徒の登録・体験">
                <div className="stack-sm">
                <Checkbox label="自己登録を受け付ける（管理者の承認が必要）" checked={s.selfRegistration} onChange={(e) => set('selfRegistration', e.target.checked)} />
                <Checkbox label="招待コードでの登録を受け付ける" checked={s.inviteCodeRegistration} onChange={(e) => set('inviteCodeRegistration', e.target.checked)} />
                <Checkbox label="体験専用の枠を一般に公開する" checked={s.trialPublicSlots} onChange={(e) => set('trialPublicSlots', e.target.checked)} />
                </div>
              </Panel>
              <Panel title="通知（メール）">
                <div className="stack">
                <div className="grid-2">
                {Object.entries(NOTIFY_LABEL).map(([k, label]) => (
                  <Checkbox key={k} label={label} checked={s.notifications[k] !== false} onChange={(e) => set('notifications', { ...s.notifications, [k]: e.target.checked })} />
                ))}
                </div>
                {numField('reminderHour', '前日リマインドを送る時刻（時）')}
                </div>
              </Panel>
              <Panel title="ログイン">
                <div className="grid-2">
                  {numField('sessionDays', 'ログイン状態を保つ日数')}
                  {numField('maxFailedLogins', 'ログインの失敗回数の上限')}
                  {numField('lockMinutes', '上限に達したときのロック（分）')}
                  {numField('resetTokenMinutes', '再設定リンクの有効時間（分）')}
                  {numField('inviteTokenDays', '招待リンクの有効日数')}
                </div>
              </Panel>
              <div className="panel" style={{ position: 'sticky', bottom: 16, zIndex: 5, boxShadow: 'var(--shadow-lg)' }}>
                <div className="panel-body spread" style={{ paddingTop: 12, paddingBottom: 12 }}>
                  <span className="small muted">{draft ? '保存していない変更があります' : '変更はありません'}</span>
                  <div className="row">
                    {draft && (
                      <Button variant="secondary" onClick={() => setDraft(null)}>
                        元に戻す
                      </Button>
                    )}
                    <Button onClick={() => void save.run(s)} pending={save.pending} disabled={!draft}>
                      設定を保存する
                    </Button>
                  </div>
                </div>
              </div>
              <Catalog />
              <InviteCodes />
            </div>
          );
        }}
      </Loadable>
    </div>
  );
}

function Catalog() {
  const toast = useToast();
  const { state, reload } = useLoad(() => Promise.all([api.get<LessonType[]>('/lesson-types'), api.get<{ id: string; name: string; active: boolean }[]>('/rooms')]), []);
  const [lt, setLt] = useState({ name: '', kind: 'private', durationMinutes: '45', capacity: '1' });
  const [room, setRoom] = useState('');
  const run = useAction(async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存できませんでした', 'error');
    }
  });
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={6} />}>
      {([types, rooms]) => (
        <div className="grid-2">
          <Panel title="レッスン種別" flush>
            <ul className="list">
              {types.map((t) => (
                <li key={t.id} className="list-row">
                  <span className="list-row-main">
                    <span className="list-title">
                      {t.name}
                      {!t.active && (
                        <span className="badge badge-muted" style={{ marginLeft: 8 }}>
                          停止中
                        </span>
                      )}
                    </span>
                    <span className="list-meta">
                      {t.kind === 'group' ? `グループ・定員${t.capacity}` : '個人'}・{t.durationMinutes}分
                    </span>
                  </span>
                  <Button variant="quiet" onClick={() => void run.run(() => api.patch(`/lesson-types/${t.id}`, { ...t, active: !t.active }), '保存しました')}>
                    {t.active ? '停止' : '再開'}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="panel-body panel-divider stack">
            <h3>レッスン種別を追加</h3>
            <TextField label="名前" hint="例: 個人 45分" value={lt.name} onChange={(e) => setLt({ ...lt, name: e.target.value })} />
            <Select label="種類" value={lt.kind} onChange={(e) => setLt({ ...lt, kind: e.target.value })}>
              <option value="private">個人</option>
              <option value="group">グループ</option>
            </Select>
            <TextField label="時間（分）" inputMode="numeric" value={lt.durationMinutes} onChange={(e) => setLt({ ...lt, durationMinutes: e.target.value })} />
            {lt.kind === 'group' && <TextField label="定員" inputMode="numeric" value={lt.capacity} onChange={(e) => setLt({ ...lt, capacity: e.target.value })} />}
            <Button
              variant="secondary"
              disabled={!lt.name}
              onClick={() => void run.run(() => api.post('/lesson-types', { name: lt.name, kind: lt.kind, durationMinutes: Number(lt.durationMinutes), capacity: Number(lt.capacity) }), 'レッスン種別を追加しました')}
              style={{ alignSelf: 'flex-start' }}
            >
              <IconPlus size={18} />
              追加する
            </Button>
            </div>
          </Panel>
          <Panel title="教室（部屋）" flush>
            <ul className="list">
              {rooms.map((r) => (
                <li key={r.id} className="list-row">
                  <span className="list-row-main">
                    <span className="list-title">
                      {r.name}
                      {!r.active && (
                        <span className="badge badge-muted" style={{ marginLeft: 8 }}>
                          停止中
                        </span>
                      )}
                    </span>
                  </span>
                  <Button variant="quiet" onClick={() => void run.run(() => api.patch(`/rooms/${r.id}`, { name: r.name, active: !r.active }), '保存しました')}>
                    {r.active ? '停止' : '再開'}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="panel-body panel-divider stack">
            <h3>教室を追加</h3>
            <TextField label="名前" value={room} onChange={(e) => setRoom(e.target.value)} />
            <Button variant="secondary" disabled={!room} onClick={() => void run.run(async () => (await api.post('/rooms', { name: room }), setRoom('')), '教室を追加しました')} style={{ alignSelf: 'flex-start' }}>
              <IconPlus size={18} />
              追加する
            </Button>
            </div>
          </Panel>
        </div>
      )}
    </Loadable>
  );
}

function InviteCodes() {
  const toast = useToast();
  const { state, reload } = useLoad(() => api.get<{ id: string; code: string; expiresAt: string | null; maxUses: number | null; usedCount: number; active: boolean }[]>('/invite-codes'), []);
  const create = useAction(async () => {
    await api.post('/invite-codes', { validDays: 30 });
    toast('招待コードを作りました（30日間有効）');
    reload();
  });
  const stop = useAction(async (id: string) => {
    await api.del(`/invite-codes/${id}`);
    reload();
  });
  return (
    <Panel
      title="招待コード"
      actions={
        <Button variant="secondary" onClick={() => void create.run()} pending={create.pending}>
          <IconPlus size={18} />
          招待コードを作る
        </Button>
      }
    >
      <div className="stack">
      <Notice>入会時にお渡しするコードです。「招待コードでの登録」を ON にすると使えます。</Notice>
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={3} />}>
        {(list) => (
          <ul className="list">
            {list.map((c) => (
              <li key={c.id} className="list-row">
                <span className="list-row-main">
                  <span className="list-title">
                    <strong className="num" style={{ letterSpacing: 2 }}>
                      <code>{c.code}</code>
                    </strong>
                  </span>
                  <span className="list-meta">
                    {c.active ? (c.expiresAt ? `${fmtDateTime(c.expiresAt)}まで` : '期限なし') : '停止中'}・{c.usedCount}回使用
                  </span>
                </span>
                {c.active ? (
                  <Button variant="quiet" onClick={() => void stop.run(c.id)}>
                    停止
                  </Button>
                ) : (
                  <span className="badge badge-muted">停止中</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Loadable>
      </div>
    </Panel>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'student.create': '生徒の登録',
  'student.update': '生徒情報の変更',
  'student.status': '状態の変更',
  'student.approve': '登録の承認',
  'student.teachers': '担当講師の変更',
  'student.note.admin': '管理用備考の変更',
  'student.note.teacher': '講師用備考の変更',
  'credits.adjust': '回数の手動調整',
  'payment.cash': '現金の入金記録',
  'settings.update': '設定の変更',
  'reservation.create': '代理予約',
  'reservation.cancel': '予約の取消',
  'reservation.approve': '仮予約の承認',
  'reservation.reject': '仮予約の却下',
  'reservation.attendance': '出欠',
  'reservation.series.create': '繰り返し予約',
  'availability.change': '空き時間の変更',
  'closure.create': '休講',
  'closure.delete': '休講の取消',
  'course.price': '料金の改定',
};

export function Audit() {
  const { state, reload } = useLoad(() => api.get<{ id: string; action: string; targetType: string; targetId: string | null; actorAccountId: string | null; createdAt: string; details: unknown }[]>('/audit-logs'), []);
  return (
    <div>
      <PageHeader title="操作記録" description="入金記録、回数の調整、解約・休会、担当講師の変更、設定の変更などを、誰が・いつ・何をしたか記録しています（最新500件）。" />
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={10} />}>
        {(list) =>
          list.length === 0 ? (
            <div className="panel">
              <Empty icon={<IconHistory />} message="操作記録はありません" />
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">日時</th>
                    <th scope="col">操作</th>
                    <th scope="col">操作した人</th>
                    <th scope="col">内容</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((l) => (
                    <tr key={l.id}>
                      <td className="nowrap num">{fmtDateTime(l.createdAt)}</td>
                      <td className="nowrap">
                        <strong>{ACTION_LABEL[l.action] ?? l.action}</strong>
                      </td>
                      <td className="nowrap">{l.actorAccountId ? <span className="badge">管理者</span> : <span className="badge badge-muted">自動処理</span>}</td>
                      <td className="small">
                        <code style={{ wordBreak: 'break-all' }}>{JSON.stringify(l.details)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loadable>
    </div>
  );
}
