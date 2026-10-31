import { PageHeader, ProfileEditor, type PhotoUpload, type TeacherProfileData } from '@hanamaru/ui';
import { api } from '../api.js';

// 自分のプロフィール（TC-07）。生徒の画面の「講師」とホームに表示される

export function Profile() {
  return (
    <div>
      <PageHeader title="プロフィール" description="生徒の画面の「講師」とホームに表示されます。写真・担当の楽器・ひとこと・経歴を入れてください。" />
      <ProfileEditor
        title="自分のプロフィール"
        load={() => api.get<TeacherProfileData>('/profile')}
        save={(input) => api.put<TeacherProfileData>('/profile', input)}
        savePhoto={(upload: PhotoUpload) => api.put<TeacherProfileData>('/profile/photo', upload)}
        deletePhoto={() => api.del('/profile/photo')}
      />
    </div>
  );
}
