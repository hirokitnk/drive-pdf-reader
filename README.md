# Drive 書庫（drive-pdf-reader）

Google Drive に置いた書籍・雑誌の PDF を、ブラウザ（スマホ・タブレット・PC）で読むビューアです。PWA として端末にインストールできます。

## 機能
- Google ログイン（読み取り専用）で、指定フォルダを本棚として表示（表紙サムネイル、フォルダ移動、検索、最近読んだ順、進捗バー）
- **右開き / 左開き**: PDF のメタデータ（`ViewerPreferences/Direction`）を初期値にして、本ごとに切り替え。ページ送りのタップ・スワイプ・キーも綴じ方向に従う
- **見開き**: 横長の画面では自動で 2 ページ表示。表紙は単独表示（オン/オフ可）。横長ページ（見開き 1 枚のスキャン）は単独表示
- ズーム（ピンチ・ダブルタップ・Ctrl+ホイール）、パン、拡大中に端を越えて引くとページ送り
- 数百 MB の PDF も、HTTP Range で必要な部分だけ取得して先頭から表示。前後のページを先読み
- 読書位置と本ごとの設定を Drive の `appDataFolder` に保存して端末間で同期（通信できないときは端末内に保存）

## 操作
| 操作 | 動作 |
|---|---|
| 画面の左右 30% をタップ | 綴じ方向に従ってページ送り（右開きなら左が「次」） |
| 中央タップ | メニューの表示/非表示 |
| 横スワイプ | ページ送り（右開きは左→右で次へ） |
| ダブルタップ | ズームの切り替え |
| ← → / Space / PageUp / PageDown / Home / End | ページ送り・先頭・末尾 |
| + / - / 0 | ズーム |

## 使い方
1. Google Cloud で OAuth クライアント ID を作る → [docs/google-cloud-setup.md](docs/google-cloud-setup.md)
2. 開発サーバーを起動する
   ```sh
   npm install
   npm run dev     # http://localhost:5173
   ```
3. ログイン画面にクライアント ID とフォルダを入力してログイン。
   ログインせずに「PDF を開く」から端末内のファイルを開くこともできます（ビューアの確認用）。

```sh
npm test            # レイアウト計算などのテスト
npm run build       # dist/ に静的ファイルを出力
```

## 公開（GitHub Pages）
`main` に push すると `.github/workflows/deploy.yml` が GitHub Pages にデプロイします。
リポジトリの Settings → Pages で Source を「GitHub Actions」にしてください。
OAuth クライアントの「承認済みの JavaScript 生成元」に `https://<ユーザー名>.github.io` を追加します。

## 構成
- `src/viewer/layout.ts` 見開き・綴じ方向の計算（純粋関数、テストあり）
- `src/viewer/viewer.ts` 描画・ジェスチャー・先読み
- `src/viewer/source.ts` PDF.js の読み込み（ローカル / Drive の Range 取得）
- `src/drive/` 認証（Google Identity Services）と Drive API
- `src/shelf/` 本棚、`src/sync.ts` 読書位置の同期

## 未対応（今後）
本のオフライン保存、見開きスキャンの 1 ページずつへの分割、本文検索としおり、紙をめくるアニメーション。

## ライセンス
MIT。PDF の描画に [PDF.js](https://github.com/mozilla/pdf.js)（Apache-2.0）を使っています。
