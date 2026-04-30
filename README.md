# SORA 安全支援チャット（静的版）

`public/` を **GitHub Pages** で公開すると、スマホから `https://` で開けます（APIキーは端末のブラウザに保存されます）。

## 1. GitHub で空のリポジトリを作成

例: リポジトリ名 `sora-safety-chat`（任意）

## 2. このフォルダを push（初回）

PowerShell で `safety-app` に移動して実行:

```powershell
cd "C:\Users\ankan_02\OneDrive - 日新興業株式会社\安全管理室\作業用\Cursor_作業box\児玉課長依頼\安全管理ﾁｬｯﾄﾎﾞｯﾄ\safety-app"

git init -b main
git add .
git commit -m "chore: initial import for GitHub Pages"

git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

`<あなたのユーザー名>` と `<リポジトリ名>` は差し替えてください。

## 3. GitHub Pages を有効化

リポジトリの **Settings → Pages**

- **Build and deployment → Source**: `GitHub Actions` を選択

`main` に push すると `.github/workflows/github-pages.yml` が走り、公開URLが表示されます。

### 公開URLの形

- ユーザー/組織サイトではなく**プロジェクトサイト**の場合:
  - `https://<ユーザー名>.github.io/<リポジトリ名>/`

## 4. 素材（画像・動画）

`public/images/` と `public/videos/` に置いたファイルも一緒に push してください（未コミットだと携帯で404になります）。

## ローカル開発（任意）

```powershell
node server.js
```

→ `http://localhost:3000`（PC内）
