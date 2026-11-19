# Annotation Atlas

Annotation付きIIIF Manifestから矩形領域を切り抜き、縦横比を保った画像の一覧を表示するブラウザアプリです。幅の異なる縦列の空いた位置に画像を積み、2pxの隙間で詰めて表示します。サーバーへのアップロードやアカウント登録は不要です。

## 起動

Node.js 20以降。追加のnpmパッケージは不要です。

```sh
cd annotation-atlas
npm start
```

http://localhost:5180 を開きます。

## 操作

- 「Manifestを読み込む」からURLまたはJSONファイルを選択し、表示された接続先を確認して読み込み。ファイルのドラッグ＆ドロップにも対応。
- 上部の検索はAnnotation本文を対象とする部分一致。空白区切りでAND検索。大文字小文字・全角半角を正規化します。
- 検索中は一致した本文を画像に重ねて表示。通常時は「テキスト」スイッチまたはホバーで表示。
- 「一括ダウンロード」で画像をZIPにまとめて保存。検索中は「検索結果をダウンロード」となり、該当画像だけを保存します。処理中は「中止」で取り消せます。
- 画像のファイル名はAnnotationの`label`を優先し、ラベルがなければ本文、本文もなければ`annotation-0001`等を使います。日本語に対応し、同名には連番を追加。フォルダ区切り・制御文字・予約名を処理し、拡張子は取得画像の実際の形式（JPEG／PNG）に合わせます。
- 画像を選択すると本文と切り抜きを表示（画像の長辺は最大4096px）。左右キーで前後に移動、Escで閉じる。
- 詳細画面から切り抜き画像と画像URLをコピー。画像コピーはPNG形式で、HTTPS（またはlocalhost）とClipboard APIに対応したブラウザ、画像のCORS許可が必要です。
- 「Miradorで開く」で該当ページへ移動し、選択領域を枠で表示・拡大。検証済みのページ・画像情報から閲覧用Manifestを組み立て、隔離したMiradorに渡します。元のAnnotation HTML・外部リンク・認証設定は渡しません。Miradorはアプリに同梱しています。
- スライダーで一覧の画像サイズを変更。`/`で検索欄へ移動。
- 初期表示はIIIF CookbookのGöttingen写真を使った24領域のサンプルです。Annotation本文はデモ用に作成したものです。

## 対応範囲

- IIIF Presentation API v2とv3
- `annotations` / `otherContent` の埋め込み・外部AnnotationPage / AnnotationList、ページネーション
- `target` / `on` に含まれる `#xywh=x,y,w,h`、百分率領域、SpecificResourceのFragmentSelector
- v3 `body.value`、v2 `resource.chars`、HTML本文のテキスト化
- IIIF Image API v1/v2/v3の矩形領域リクエスト。任意領域と幅指定に対応したImage Service（通常level1以上）が必要
- Canvas座標から画像座標への換算。単一画像または単一画像をCanvasの一部へ配置するpaintingに対応

複数画像を重ねたCanvas、回転したpainting、SVG多角形、時間領域、認証付きサービスには対応しません。切り抜き対象は矩形領域を持つAnnotationです。全文Canvasのみを対象にしたAnnotationは読み込みメモに表示します。

Manifest・参照Annotation・Image Serviceは、ブラウザからのアクセスと必要なCORSを許可する必要があります。ローカルJSONから相対URLを参照する場合は、Manifestの`id` / `@id`に絶対URLが必要です。読み込み失敗やスキップは画面に表示されます。

画像は各機関のIIIF Image APIから直接読み込みます。本文はHTMLとして挿入しません。読み込んだ資料はブラウザメモリ内で扱い、リロードするとサンプル表示に戻ります。`dist/`を静的ホスティングに配置できます。

## 管理・配信

ソースはGitHub、配信はCloudflareで管理します。配信対象は`dist/`です。Node.jsの`server.mjs`はローカル確認用で、本番サーバーは不要です。

このプロジェクトをGitHubリポジトリのルートに置く場合は、`package.json`、`dist/`、`server.mjs`、`tests/`、`README.md`をそのまま管理します。`dist/`は生成される出力ではなく、アプリ本体なのでGitに含めます。

CloudflareとGitHubの接続先・公開設定は配信先で設定してください。アプリの検証は`npm test`と`npm run build`で行えます。

## 不正入力への対策

- JSONは1ファイル／1レスポンス8MB、参照JSONの取得合計32MB（Manifest本体は別途8MB）、構造の深さ40、要素数15万、文字列1件10万文字まで。URL指定時もストリームを読みながら容量を検査します。
- Canvasは500件、切り抜きは5000件、外部Annotationページと参照先はそれぞれ128件、埋め込みページは2000件まで。本文は1件2万文字、合計500万文字まで。
- 接続先は最大16オリジン。読み込み前に確認したオリジンだけを許可し、追加の接続先やリダイレクトを拒否します。IPアドレス表記、localhost・ローカル向けホスト名、認証情報付きURL、標準以外のポートは受け付けません。
- 通信の同時実行は4件、1通信15秒、Manifest読み込み全体60秒まで。Cookie・HTTP認証・参照元URLを送信しません。画像表示にもCORS許可が必要です。
- 画像はJPEG／PNGのみ。取得容量12MB、縦横8192px、総画素数16メガピクセルまでをデコード前にヘッダーで検査。一覧の画像キャッシュは32MB、画像取得の合計は256MBまでです。
- 一括ダウンロードは同じ接続先・形式・画像寸法の検査を通し、最大5000件・画像合計128MB・5分まで。1件でも取得に失敗した場合は、不完全なZIPを保存せずエラーを表示します。サーバーへのアップロードは行いません。
- HTML本文はDOMにパースせず文字列へ変換し、表示は`textContent`等で行います。危険なオブジェクトキーと不正な数値も拒否します。
- Miradorは`allow-scripts`のみのsandbox iframe内で実行します。親画面・ストレージ・クリップボードへアクセスさせず、直接の外部通信をCSPで禁止します。画像・Image Service情報の取得は親側の検証付き処理を介し、1回の閲覧につき512通信・合計128MB・5分までに制限します。
- `dist/_headers`にCSP、Referrer-Policy、nosniff、Permissions-Policy等を定義しています。ローカル確認サーバーでも同じヘッダーを設定します。Cloudflareでは`dist/`全体をStatic Assetsとして配信し、`_headers`も含めてください。独自Workerでレスポンスを生成する場合は、これらのヘッダーをWorker側にも設定する必要があります。

上限や拒否に達するとエラーを表示します。リダイレクトを使う資料は、最終的なURLで指定してください。ローカルIIIFサーバーや認証付きサービスはこの構成では利用できません。

ブラウザだけでホスト名の実際の解決先IPを固定・検証することはできません。確認する接続先には、信頼できる機関のホスト名を指定してください。DNSリバインディングまで防ぐ強制的なIP制限が必要な場合は、接続先IPを検証する専用サーバー側プロキシが別途必要です。ブラウザ・画像デコーダー・同梱ライブラリの未知の脆弱性まで安全を保証するものではありません。

ヘッダー仕様の参考 [Cloudflare Static Assets](https://developers.cloudflare.com/workers/static-assets/headers/)。

## 検証

```sh
npm test
npm run build
```

仕様参考 [Presentation v3](https://iiif.io/api/presentation/3.0/)、[Presentation v2](https://iiif.io/api/presentation/2.1/)、[Image API](https://iiif.io/api/image/3.0/)。

Mirador 3.3.0とライセンスを`dist/vendor/`に同梱しています。[Mirador](https://github.com/ProjectMirador/mirador)はApache License 2.0で配布されています。
