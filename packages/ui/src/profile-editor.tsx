import { useEffect, useId, useRef, useState } from 'react';
import { fieldErrors } from './api.js';
import { Button, ConfirmDialog, Loadable, Notice, Panel, Skeleton, TextArea, TextField, Warning, useToast } from './components.js';
import { useAction, useLoad } from './hooks.js';
import { IconUpload } from './icons.js';

// 講師のプロフィールの編集（TC-06、TC-07）。管理画面と講師の画面で同じ部品を使う（UI-06）

export interface TeacherProfileData {
  teacherId: string;
  name: string;
  instruments: string[];
  career: string;
  message: string;
  photo: string | null;
  /** 写真の大きさ（バイト）と、おすすめの大きさを超えているか（TC-06） */
  photoSize?: number | null;
  photoLarge?: boolean;
  photoRecommendedKB?: number;
}

export interface PhotoUpload {
  contentType: 'image/jpeg';
  dataBase64: string;
}

/** 写真の一辺（px）。生徒の画面では丸く出す。高解像度の画面でもきれいに見える大きさ */
const PHOTO_SIZE = 1080;
const PHOTO_QUALITY = 0.9;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('写真を読み込めませんでした。別の写真を選んでください'));
    el.src = src;
  });
}

/** 画像の真ん中を正方形に切り抜き、一辺 side 以下に縮めて JPEG にする */
function encodeSquare(img: HTMLImageElement, side: number, quality: number): { upload: PhotoUpload; previewUrl: string; bytes: number } {
  const crop = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(side, crop);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('写真を読み込めませんでした');
  g.drawImage(img, (img.naturalWidth - crop) / 2, (img.naturalHeight - crop) / 2, crop, crop, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  // base64 の4文字が3バイト
  const bytes = Math.floor((dataBase64.length * 3) / 4) - (dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0);
  return { upload: { contentType: 'image/jpeg', dataBase64 }, previewUrl: dataUrl, bytes };
}

/**
 * 選んだ写真を、真ん中で正方形に切り抜いて一辺 1080px までに縮め、JPEG にする。
 * おすすめの大きさを超えても、そのまま保存できる（あとで「画質を下げる」で小さくできる）
 */
export async function squarePhoto(file: File): Promise<{ upload: PhotoUpload; previewUrl: string }> {
  const url = URL.createObjectURL(file);
  try {
    const { upload, previewUrl } = encodeSquare(await loadImage(url), PHOTO_SIZE, PHOTO_QUALITY);
    return { upload, previewUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 保存済みの写真を、おすすめの大きさ（targetKB）に収まるまで画質を下げて作り直す。
 * 画質を段階的に下げ、それでも収まらなければ一辺も小さくする
 */
export async function shrinkPhoto(src: string, targetKB: number): Promise<{ upload: PhotoUpload; previewUrl: string; bytes: number }> {
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('写真を読み込めませんでした。時間をおいてもう一度お試しください');
  const url = URL.createObjectURL(await res.blob());
  try {
    const img = await loadImage(url);
    let side = Math.min(PHOTO_SIZE, img.naturalWidth, img.naturalHeight);
    let last = encodeSquare(img, side, 0.8);
    for (let round = 0; round < 6; round++) {
      for (const q of [0.8, 0.7, 0.6, 0.5]) {
        last = encodeSquare(img, side, q);
        if (last.bytes <= targetKB * 1024) return last;
      }
      side = Math.round(side * 0.8);
    }
    return last;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString('ja-JP')}KB`;

const splitInstruments = (s: string) =>
  s
    .split(/[、,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function ProfileEditor({
  load,
  save,
  savePhoto,
  deletePhoto,
  title = 'プロフィール',
  description,
}: {
  load: () => Promise<TeacherProfileData>;
  save: (input: { instruments: string[]; career: string; message: string }) => Promise<TeacherProfileData>;
  savePhoto: (upload: PhotoUpload) => Promise<TeacherProfileData>;
  deletePhoto: () => Promise<unknown>;
  title?: string;
  description?: string;
}) {
  const { state, reload } = useLoad(load, []);
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
      {(p) => <ProfileForm key={p.teacherId} initial={p} title={title} description={description} save={save} savePhoto={savePhoto} deletePhoto={deletePhoto} onChanged={reload} />}
    </Loadable>
  );
}

function ProfileForm({
  initial,
  title,
  description,
  save,
  savePhoto,
  deletePhoto,
  onChanged,
}: {
  initial: TeacherProfileData;
  title: string;
  description?: string;
  save: (input: { instruments: string[]; career: string; message: string }) => Promise<TeacherProfileData>;
  savePhoto: (upload: PhotoUpload) => Promise<TeacherProfileData>;
  deletePhoto: () => Promise<unknown>;
  onChanged: () => void;
}) {
  const toast = useToast();
  const fileId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [instruments, setInstruments] = useState(initial.instruments.join('、'));
  const [career, setCareer] = useState(initial.career);
  const [message, setMessage] = useState(initial.message);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [photo, setPhoto] = useState<string | null>(initial.photo);
  const [photoSize, setPhotoSize] = useState<number | null>(initial.photoSize ?? null);
  const [photoLarge, setPhotoLarge] = useState(!!initial.photoLarge);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setPhoto(initial.photo);
    setPhotoSize(initial.photoSize ?? null);
    setPhotoLarge(!!initial.photoLarge);
  }, [initial.photo, initial.photoSize, initial.photoLarge]);
  const showSaved = (saved: TeacherProfileData) => {
    setPhoto(saved.photo);
    setPhotoSize(saved.photoSize ?? null);
    setPhotoLarge(!!saved.photoLarge);
  };
  const dirty = instruments !== initial.instruments.join('、') || career !== initial.career || message !== initial.message;

  const saveText = useAction(async () => {
    try {
      await save({ instruments: splitInstruments(instruments), career, message });
      setErrors({});
      toast('プロフィールを保存しました');
      onChanged();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast(e instanceof Error ? e.message : '保存できませんでした', 'error');
    }
  });
  const upload = useAction(async (file: File) => {
    try {
      const { upload: data, previewUrl } = await squarePhoto(file);
      setPhoto(previewUrl);
      showSaved(await savePhoto(data));
      toast('写真を保存しました');
    } catch (e) {
      setPhoto(initial.photo);
      toast(e instanceof Error ? e.message : '写真を保存できませんでした', 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  });
  const shrink = useAction(async () => {
    if (!photo) return;
    const before = photoSize;
    try {
      const { upload: data } = await shrinkPhoto(photo, initial.photoRecommendedKB ?? 800);
      const saved = await savePhoto(data);
      showSaved(saved);
      toast(before && saved.photoSize ? `写真を小さくしました（${kb(before)} → ${kb(saved.photoSize)}）` : '写真を小さくしました');
    } catch (e) {
      toast(e instanceof Error ? e.message : '写真を小さくできませんでした', 'error');
    }
  });
  const remove = useAction(async () => {
    try {
      await deletePhoto();
      setPhoto(null);
      setPhotoSize(null);
      setPhotoLarge(false);
      setConfirmDelete(false);
      toast('写真を削除しました');
    } catch (e) {
      setConfirmDelete(false);
      toast(e instanceof Error ? e.message : '削除できませんでした', 'error');
    }
  });

  return (
    <Panel
      title={title}
      footer={
        <Button onClick={() => void saveText.run()} pending={saveText.pending} disabled={!dirty}>
          プロフィールを保存
        </Button>
      }
    >
      <div className="stack">
        {description && <p className="small secondary">{description}</p>}
        <div className="profile-photo-edit">
          {photo ? (
            <img className="profile-photo profile-photo-lg" src={photo} alt={`${initial.name}の写真`} width={96} height={96} />
          ) : (
            <span className="avatar avatar-xl" aria-hidden="true">
              {(initial.name.trim().split(/\s+/).pop() ?? initial.name).slice(0, 1)}
            </span>
          )}
          <div className="stack-sm">
            <p className="small secondary">写真は真ん中を正方形に切り抜いて、生徒の画面に丸く表示します。</p>
            <div className="row">
              <label className="btn btn-secondary" htmlFor={fileId} aria-disabled={upload.pending || undefined}>
                <IconUpload size={18} />
                {upload.pending ? '保存しています…' : photo ? '写真を変える' : '写真を選ぶ'}
              </label>
              <input
                ref={fileRef}
                id={fileId}
                type="file"
                accept="image/*"
                className="visually-hidden"
                disabled={upload.pending}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload.run(f);
                }}
              />
              {photo && (
                <Button variant="quiet" onClick={() => setConfirmDelete(true)}>
                  写真を削除
                </Button>
              )}
            </div>
          </div>
        </div>
        {photo && photoLarge && photoSize != null && (
          <Notice>
            <div className="stack-sm">
              <p>写真が大きめです（{kb(photoSize)}）。表示が遅くなることがあります。</p>
              <div>
                <Button variant="secondary" onClick={() => void shrink.run()} pending={shrink.pending} pendingLabel="小さくしています…" disabled={upload.pending}>
                  画質を下げる
                </Button>
              </div>
            </div>
          </Notice>
        )}
        <TextField
          label="担当の楽器"
          hint="「、」で区切って入力（例: ピアノ、ドラム）"
          value={instruments}
          error={errors.instruments}
          onChange={(e) => setInstruments(e.target.value)}
        />
        <TextArea label="ひとこと" hint="生徒の画面で、名前の下に大きく表示します" value={message} error={errors.message} onChange={(e) => setMessage(e.target.value)} />
        <TextArea label="経歴" value={career} error={errors.career} onChange={(e) => setCareer(e.target.value)} rows={6} />
        {Object.keys(errors).length > 0 && <Warning title="入力に誤りがあります" />}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="写真を削除しますか"
        confirmLabel="削除する"
        cancelLabel="削除しない"
        pending={remove.pending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove.run()}
      >
        <p>生徒の画面では、写真の代わりに名前の1文字目を表示します。</p>
      </ConfirmDialog>
    </Panel>
  );
}
