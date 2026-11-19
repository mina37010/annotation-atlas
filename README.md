# Annotation Atlas

Annotation付きIIIF Manifestから矩形領域を切り抜き、縦横比を保った画像の一覧を表示するブラウザアプリです。サーバーへのアップロードやアカウント登録は不要です。

## 起動

Node.js 20以降。追加のnpmパッケージは不要です。

```sh
cd annotation-atlas
npm start
```

http://localhost:5180 を開きます。

## 操作

- 「Manifestを読み込む」からURLまたはJSONファイルを選択。ファイルのドラッグ＆ドロップにも対応。
- 上部の検索はAnnotation本文を対象とする部分一致。空白区切りでAND検索。大文字小文字・全角半角を正規化します。
- 検索中は一致した本文を画像に重ねて表示。通常時は「テキスト」スイッチまたはホバーで表示。
- 画像を選択すると本文と元解像度の切り抜きを表示。左右キーで前後に移動、Escで閉じる。
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

## 検証

```sh
npm test
npm run build
```

仕様参考 [Presentation v3](https://iiif.io/api/presentation/3.0/)、[Presentation v2](https://iiif.io/api/presentation/2.1/)、[Image API](https://iiif.io/api/image/3.0/)。
