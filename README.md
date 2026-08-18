# N% English

N% English は、閲覧中のWebページにある日本語文章の一部だけを自然な英語へ置き換える、個人利用向けのChrome拡張機能です。ページ全体を翻訳せず、日常の閲覧体験へ英語学習を少しずつ混ぜることを目的にしています。

## 技術構成

- Chrome Extension Manifest V3
- TypeScript / Vite
- Vanilla TypeScript / CSS（UIフレームワークなし）
- Vitest / jsdom
- OpenAI Responses API
- `gpt-5.6-luna`
- Structured Outputs（`text.format` のJSON Schema、`strict: true`）
- `reasoning: { effort: "none" }`、`store: false`、ツールなし

API通信はBackground Service Workerだけが `fetch` で行います。Content Scriptへ渡るのは抽出した文章と翻訳結果だけで、APIキーは渡しません。実装時点のAPI形式は、OpenAI公式の[Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)を基準にしています。

## 必要なもの

- Chrome 140以降
- Node.js 20以降とnpm
- 利用可能なOpenAI APIキー

OpenAI APIの利用料金は、キーを所有するアカウントに発生します。この拡張機能にAPI利用枠は付属しません。

## インストールとビルド

リポジトリのルートで次を実行します。

```bash
npm install
npm run build
```

`dist/` に、Chromeがそのまま読み込めるManifest V3拡張機能が生成されます。ビルドの最後には、manifest、Options Page、Service Worker、単一ファイルのContent Scriptが揃っていることも検査します。

### Chromeへ読み込む

1. Chromeで `chrome://extensions` を開きます。
2. 右上の「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」を押します。
4. このリポジトリの `dist/` ディレクトリを選択します。
5. 拡張機能の詳細画面から「拡張機能のオプション」を開きます。

ソースを変更した場合は `npm run build` を再実行し、`chrome://extensions` の拡張機能カードにある更新ボタンを押してください。

## 設定

Options Pageで次を入力して「設定を保存」を押します。

- OpenAI APIキー: password入力です。表示ボタンで一時的に確認できます。保存済みのキーがある場合、空欄のまま保存すると既存キーを維持します。
- 翻訳率: 0〜100%。スライダーと数値入力は同期します。初期値は20%です。
- 自動翻訳対象ドメイン: 1行に1つ、URLやパスではなくホスト名だけを入力します。例: `example.com`。

`example.com` を登録すると、`example.com` と `www.example.com` など全サブドメインが対象になります。保存時に対象ドメインだけの任意サイト権限をChromeへ要求します。権限を許可しなかった場合、自動実行設定は保存されません。ドメインを設定から削除すると、対応する動的Content Script登録と不要になった権限も解除します。

親ドメインからその一部のサブドメインへ設定を狭める場合（例: `example.com` から `news.example.com`）、自動実行範囲は直ちに狭まります。一方、Chromeは既存の親権限に包含される狭い権限を別grantとして作らない場合があるため、動作を切らさないよう親権限は自動削除しません。権限自体も狭めたい場合は、Chromeの拡張機能サイト設定で旧親権限を削除し、Options Pageでもう一度保存してください。権限が不足しているドメインはOptions Pageにエラー表示されます。

設定画面の「翻訳キャッシュを削除」から、保存済み翻訳をすべて削除できます。

## 使い方

### 自動翻訳

許可済みの自動翻訳対象ドメインを開くと、初回ページ読み込み時に日本語文章を抽出して翻訳します。処理状況はページ右上のtoastと拡張機能badgeに表示されます。

### 手動翻訳と復元

自動翻訳対象に登録していない通常のHTTP/HTTPSページでも、拡張機能アイコンを押すと `activeTab` 権限でそのページに限り一度実行します。英語へ置き換わった文章をクリックすると、その文章だけ日本語へ戻せます。リンク内の英訳を戻すクリックではリンク遷移を行いません。翻訳済みページで再度アイコンを押すと、残っている英訳をまとめて元の日本語へ戻します。同じページで処理中に再度操作しても、APIリクエストは重複実行されません。

APIキーが未設定の状態でアイコンを押すとOptions Pageを開きます。`chrome://`、拡張機能ページ、Chrome Web Storeなど、スクリプトを挿入できないページでは実行せず、badgeにエラーを表示します。

### エラーの確認

ページ内のエラーtoastは自動では消えず、「×」を押すまで残ります。詳細ログには `[N% English]` という接頭辞が付きます。ページ処理のログはそのタブのDevTools Console、設定保存のログはOptions PageのDevTools Console、API・キャッシュ・権限処理のログは `chrome://extensions` の拡張機能カードにある「Service Worker」から確認できます。APIキーと翻訳対象本文はログへ出力しません。

## 権限

- `storage`: 設定、APIキー、翻訳キャッシュを `chrome.storage.local` に保存します。`chrome.storage.sync` は使いません。
- `scripting`: 設定済みドメインへの動的登録と、手動実行時のContent Script挿入に使います。
- `activeTab`: アイコンを押した未登録ページで、そのタブに限って手動実行するために使います。
- `https://api.openai.com/*`: Background Service WorkerからResponses APIへ接続するための常時host permissionです。
- 任意のHTTP/HTTPS host permission: Options Pageで明示的に許可した自動翻訳対象ドメインだけに使います。

Chromeの権限モデルについては、公式の[Optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[Dynamic content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#inject-with-dynamic-declarations)、[`activeTab`](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)も参照してください。

## APIキーの取り扱いと重要な注意

APIキーは [`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/api/storage/) に保存され、Background Service Workerだけが読み出します。起動時にストレージのアクセスレベルを信頼済み拡張機能コンテキストへ制限し、その完了前や失敗時にはキーの保存・読み出し・API通信を行いません。この分離を `storage.local` で利用できるChrome 140以降を対象としています。Content Scriptへの送信、通常ページのDOMへの挿入、ログ出力、エラーメッセージへの埋め込み、翻訳キャッシュへの保存は行いません。

ただし、ブラウザー内にAPIキーを保存する方式は、第三者へ一般公開する拡張機能には適していません。端末やChromeプロファイルへアクセスできる人、または悪意ある拡張機能にキーを取得される可能性があります。本実装は自分だけで使うローカルMVPを前提としています。一般公開する場合は、APIキーを拡張機能へ配布せず、認証・利用制限・監査を備えた自分のバックエンド経由でOpenAI APIを呼ぶ構成へ変更してください。

また、翻訳対象として抽出されたページタイトル、URL、日本語文章、直前の見出しはOpenAI APIへ送信されます。機密情報を含むページでは実行しないでください。HTML全体、`innerHTML`、属性値は送信しません。

## テスト

実際のOpenAI APIは呼ばず、通信をモックして実行します。

```bash
npm run test
npm run typecheck
npm run build
```

テストは、ドメイン正規化・サブドメイン判定、DOM抽出除外、`Intl.Segmenter` による文章分割、原文文字数による翻訳率計算、連続文章の回避、APIレスポンス検証、検証失敗時の再試行、401・429・その他HTTPエラー・通信・タイムアウト、API失敗時のDOM不変、翻訳適用・復元、実リクエスト量によるチャンク分割、並列数制限、キャッシュキー・LRU・削除世代、ストレージ隔離を対象にしています。

## 実装上の前提

- 翻訳率は、空白を除いた候補原文のUnicode文字数を分母にして計算します。文章単位で置換するため完全一致できない場合は、設定割合へ最も近い組み合わせを選びます。
- 設定割合を満たせる範囲では、ページ順で隣り合う文章を同時に選ばず、ページ全体へ分散させます。モデルの選択が文字数や連続性の希望から外れた場合、返却済み翻訳をローカルで間引ける範囲だけ調整し、調整しきれない差は警告ログに残して結果を適用します。
- 短いUIラベルを避けるため、意味のある文字が5文字未満、日本語文字が3文字未満、または8文字以下で文末記号のない文字列を候補から除外します。
- 大きいページは文章を分断せず、最大100文章または、instructions・Schema・タイトル・URL・JSONエスケープまで含む直列化済みリクエストが概ね96KBになるごとに分割します。1文章だけでsoft limitを超える場合も途中では切らず、512KBを超えて実行不能な場合だけ本文を含まない固定エラーで停止します。ページ全体の対象文字数は各チャンクへ文字量に応じて配分し、低率時は過剰選択を避けるため必要なチャンクだけを分散して使用します。最大3リクエストを並行処理します。
- APIタイムアウトは1リクエスト25秒、ページ全体の翻訳ジョブは4分です。全体deadlineでは進行中のチャンクも共通signalで中止し、ChromeのService Worker実行上限より前に制御されたエラーを返します。不正なレスポンスだけを最大1回再試行し、HTTPエラーは自動再試行しません。
- 翻訳キャッシュは最大30件で、古く使われていないものから削除します。ページタイトル、URL、抽出文章一覧のハッシュ、翻訳率、モデル名、プロンプトバージョンのいずれかが変わると再利用しません。削除操作より前に開始した通信結果は、削除後にキャッシュへ書き戻しません。

## 現在のMVPの制約

- iframe内は対象外です。
- Webページ側のShadow DOM内は対象外です。
- 初回ページ読み込みとアイコンによる手動実行が対象です。SPAで読み込み後に追加された本文は自動再処理しません。
- 複数のDOMテキストノードをまたぐ文章は対象外です。
- 対象はHTTP/HTTPSのトップフレームです。
- 翻訳から元表示へ戻すための原文はページ内メモリだけに保持するため、再読み込み後には引き継ぎません。
- 極端に大量の候補を含むページについて、処理ジョブを永続化してService Worker再起動後に再開する機能はありません。分割・最大3並列・25秒の個別timeout・4分の全体deadlineを行いますが、deadlineに達した場合はページを再読み込みして再試行する必要があります。完了済みのチャンクを含めてDOMとキャッシュは更新しませんが、複数チャンクは複数回のAPI利用として課金対象になります。
