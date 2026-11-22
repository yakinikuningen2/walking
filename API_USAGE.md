# 公開ルートAPI対応・運営者向け確認（2026-11-16）

## 結果

Valhallaのサーバー中継・識別・共有制限、ORS新URLへの移行、自動要求の抑制、出典表示、プライバシーポリシーを実装しました。運営者名は利用者の指定どおり**yakinikuningen**、問い合わせ先は事前に案内したGitHub Issuesを使う案です。

**技術的な対応と、提供元の許諾・個別契約の確認は別です。** Valhallaへの通知投稿・ORSへの照会・本番デプロイはしていません。これらを完了した、あるいは現在地座標の送信が無条件で許可されたとは報告しません。

## URLと現行条件

| 対象 | 更新版が使うURL | 確認した一次資料・条件 |
| --- | --- | --- |
| Valhalla | `https://valhalla1.openstreetmap.de/route`、`/locate`、`/height`（POST） | [公式README](https://github.com/valhalla/valhalla#demo-server)のfair-use・公開アプリのDiscussions連絡依頼・X-Client-Id。[API仕様](https://valhalla.github.io/valhalla/api/route/api-reference/)。FOSSGISの規約全文はアクセス拒否で未確認。READMEが参照する[提供元の概要](https://routing.openstreetmap.de/about.html)には識別・帰属・地図修正リンク・最大1回/秒・大量利用禁止の説明があるが、OSRMのページをValhallaの全条件の代わりとは扱わない |
| ORS | `https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson`（POST） | [2026-04-28の公式移行案内](https://ask.openrouteservice.org/t/deprecating-api-openrouteservice-org-in-favour-of-api-heigit-org/7912)、[2026-10-22の移行・停止案内](https://heigit.org/changes-in-the-openrouteservice-universe/)、[現行HeiGIT規約](https://account.heigit.org/info/tos)。既存キーを新URLでも使える案内。結果のCC BY-SA 4.0・帰属、契約上限、個人データ送信禁止は別途適用 |
| 公開アプリ | `https://walking-ctsh.onrender.com/` | 運営者から提示されたURL。2026-11-16の`/api/health`は初回15秒でタイムアウトし、後の確認はHTTP200。本番のコード版・更新機能・負荷は未検証 |

旧`https://api.openrouteservice.org/v2/directions/foot-walking/geojson`は使用しません。新URLは`api.heigit.org/openrouteservice/v2/…`であり、`/heigit/openrouteservice/…`を追加するものではありません。APIキーはPythonの環境変数`ORS_API_KEY`だけから読み、固定HTTPS宛のAuthorizationヘッダーに使用します。リダイレクトは追跡せず、ブラウザ・URL・JSON応答・ログへキーを出しません。

## 実装した識別・制限

Valhallaは全機能をPythonの`POST /api/valhalla`に集約しました。パス・歩行モード・地点数・座標・許可オプションを検証し、任意URL・氏名等の追加フィールド・巨大な入力を拒否します。routeは最大50地点、locateは16地点、heightは24地点。JSON応答の上限は12MiB。ブラウザへの応答はno-storeです。

送信ヘッダー：

```text
X-Client-Id: walking-ctsh.onrender.com
User-Agent: WalkingMap/1.0 (+https://walking-ctsh.onrender.com/; https://github.com/yakinikuningen2/walking)
```

ブラウザからのX-Forwarded-For・Cookie・端末ID等を上流へ転送しません。通信元IPはアプリサーバーのIPになりますが、精密な位置座標が匿名になる保証はありません。

| 制御 | Valhalla | ORS |
| --- | ---: | ---: |
| 上流への同時要求 | 1件 | 1件 |
| 要求開始の最短間隔 | 1秒 | 2秒 |
| 直近60秒の上限 | 45回 | 20回 |
| 直近24時間の上限 | 1000回 | 500回 |
| 待機要求・時間 | 最大2件・2秒 | 最大2件・2秒 |
| 429後 | Retry-Afterを参照し、最低60秒の待機を共有。ブラウザにも待機を案内 | 同左 |
| 5xx後 | 15秒の共有待機 | 同左 |
| 成功キャッシュ | 5分・64件・合計16MiB。完全に同じ要求を同時実行しない | 既存の正常な提案キャッシュ5分・32件を維持 |

上限は**アプリ独自の保守的な値**です。提供元がこの量を許可・保証したという意味ではありません。上限に達したら429を返し、既知の失敗で連打・自動再送しません。Valhallaの中継障害時にブラウザ直結へ戻して制限を回避する処理もありません。Live Serverでも更新後のPythonサーバーが必要です。

ブラウザでの中止は古い応答の採用と未送信の処理を止めますが、既にサーバーから提供元へ送った処理を即座に中止できる保証はありません。その部分はサーバーの同時数・待機上限・タイムアウト・全体予算で制限します。

制限用に保存するのは呼出し時刻であり、IP・氏名・座標を使った利用者追跡のためのDBではありません。各APIの全利用者で共有されますが、**1プロセスのメモリ上の制限**です。プロセスを再起動すると消え、別プロセス・別インスタンス・同じキーを使う他アプリには共有されません。Render設定の`python -u app.py --host 0.0.0.0 --port $PORT`は単一プロセスです。複数化する場合は共通の中継・制限を先に用意する必要があります。再起動を利用上限の回避策にしてはいけません。

## 自動処理の抑制

- 候補の自動距離取得は見えている候補だけ、1ページ読込あたり8件まで。それ以上は「距離を確認」を利用者が押す。キャッシュは使え、距離を架空の直線推定値で補わない。
- 候補が非表示・削除・古い検索になった場合は中止。8件の数え方は安全側で、後で中止された要求も予算を消費する場合がある。
- 地図のパン・ズーム・単なる起動ではルートを検索しない。GPSの取得と、外部のルート検索は別。
- 現在地に基づく更新は精度・複数の位置情報で2秒の継続確認、通常30mの進行または逸脱、最低10秒の間隔を満たす場合。確認後は待機終了時にも再判定し、地図の開き直しを不要にする。ページ非表示中は待機タイマーも停止する。通常の自動更新で無関係なルート種類をすべて生成し直さない。取得中のリクエストをGPS更新で中断しない。
- 周遊は利用者操作で開始し、生成45秒・ルート取得14回の既存上限を維持。
- 長距離分割は最大16区間・分割120秒・全体150秒、歩行道路の中継照合を維持。新しい制限に達した場合も、直線で補ったり無制限再試行したりしない。
- 経由ルートの更新はメインと別に管理するが、通信は同じサーバー制限を通る。
- 保存した道との重複は端末内で比較する。2地点・直線20km未満のValhalla検索は `alternates: 2` を同じ1リクエストに付け、取得できた最大3候補を比較する。保存軌跡・体重・メモを送信しない。候補追加がなくても再試行しない。複数寄り道は5地点まで・編集待機300ms・全体45秒・最大6区間。散歩計測・歩数計の機能は削除済み。登録済みのルートの比較自体は追加の検索リクエストを発生させない。

## 位置情報の流れ

1. ブラウザが許可後に現在地を取得・更新。端末の生の方位センサー値・位置精度は表示・判定用で、Valhalla／ORSへの送信項目ではない。
2. Valhalla：ブラウザ→自分の`/api/valhalla`→Valhalla。座標・速度・歩行条件・回避範囲を送る。サーバーで原則小数6桁へ丸める。緯度経度を含むGET URLを外部へ送らずPOST本文を使うが、POSTだから機密性・匿名性が保証されるわけではない。
3. ORS：ブラウザ→`/api/walking-routes`→新HeiGIT API。出発地点・目的地・経由地・帰着地点・回避範囲等を送る。現在地を選べばその座標が含まれる。歩く速さはアプリサーバーで受け、所要時間の算出にも使う。
4. 登録メモ・訪問日・本人確認した散歩実績・端末ID・ブラウザIPはこれらのAPI本文に付けない。ただし位置そのものから個人や自宅等を推定できる場合はあり得る。
5. その他のPhoton、Overpass、Wikimedia、タイル、CDN、Renderへの通信経路と送信内容も[ポリシー](static/privacy.html)に記載。Valhallaをサーバー経由にしたことを、全サービスがサーバー経由になったと誤表示しない。

キャッシュは再利用の期限と物理的な削除時点を区別し、次アクセス・上限による入替え・プロセス終了時に消去する場合があることを明記しました。APIパスのアプリ標準アクセスログは抑制し、座標入り本文・APIキーを記録しません。ホスティング側のログや静的ファイルへのIP・日時・パスの記録は別です。

## ORSの個人情報条項

ログインしない一時ブラウザで2026-11-16に現行規約の動的本文を再確認しました。Prohibited Conductには、HeiGITアカウント管理で必要なものを除く個人データの送信禁止があり、Attribution and LicenseではORS結果のCC BY-SA 4.0、Usage Limitsではアカウント・速度・回数に関する制限が定められています。

**位置座標が常に個人データに当たる、あるいは常に当たらないとは断定していません。** 氏名等を送らない、サーバー中継にする、座標を丸める、利用者が位置情報を許可する、ポリシーを置く、といった対応だけでこの禁止事項が免除されるとは判断しません。コードだけでは確定できないため、現在地を含む用途について運営者が提供元へ確認する必要があります。アプリ機能を無断で停止・削除したものでもありません。

確認時に使える説明例：

> Our walking web app sends a user-selected start/destination, which may include the device's current coordinates, to ORS through our server. We do not attach names, device IDs, private notes or the user's IP address, but the coordinates themselves can be precise. Under the personal-data restriction in your Terms of Service, is this use permitted, and what additional safeguards or plan/contract would be required?

これは照会用の案で、送信していません。Private.coffee Overpassにも個人識別可能情報に関する条件があり、必要に応じて別途確認が残ります。

## 出典とポリシー

地図上の`© OpenStreetMap contributors`と著作権ページ、地図修正リンク、Valhalla／FOSSGISの帰属を維持。ORS結果を表示するときは`© openrouteservice by HeiGIT`とCC BY-SA 4.0へのリンクを表示します。アプリの設定・初回ガイド・出典一覧からプライバシーポリシーに到達できます。API結果のライセンスを独自コード全体へ一括適用しません。

ポリシーの運営名はyakinikuningenです。問い合わせはGitHub Issuesを使う案であり、公開前に運営者が受付方法として確認してください。Issuesへ氏名・自宅・現在地・履歴・キーを公開しないよう記載しました。個人情報を含む受付が必要なら、非公開の連絡経路を運営者が用意してください。

## 検証結果

- JavaScript230件・Python104件、計334件が成功。既存の検索・現在地・周遊・寄り道・写真・登録・長距離等も含む。
- 新規のPython13件は複数呼出し元の同時数・間隔、分／日予算、429の待機、短い待機上限、固定先・ヘッダー・入力の丸め、任意URLや個人名の拒否、キャッシュ・同時要求の共通化、機密を含む上流エラーの非公開、タイムアウト、応答サイズ上限、CORS・HTTP・Retry-After等を検証。
- JavaScriptはValhallaが自サーバーへPOSTすること、404や中止後に直結しないこと、8件の自動予算と手動操作を検証。
- Chromeの1440×900・390×844・320×568で、通常案内・条件／ランダム検索・写真・登録・周遊の既存操作、8件で自動取得停止→9件目を明示クリックで取得、ボタンの入れ子がないこと、ポリシーの幅収まり、設定・ガイド・出典リンク、出典8区分／サービス9区分を確認。APIとタイルは固定応答で提供元へ大量アクセスしていない。
- 固定した東京駅付近→有楽町付近の実通信：Valhalla route・locate・height各1回が成功。道のり1108.034m、route約1.619秒。繰返しrouteはキャッシュ命中し、提供元への呼出しは3回のまま。新しい識別とPOST形式で成功。
- ORS新URLはキー未設定のため認証なしでHTTP401を確認。認証付き経路・個別プラン上限は未検証。新URLの固定先とAuthorizationだけにキーを入れることは自動試験で確認。
- 公開healthは再確認でHTTP200。公開中のコードを更新したり、公開APIへ位置情報を送って試験したりはしていない。実機iPhone Safariは未検証。

通常の試験：

```powershell
node --test test_nearby_routing.cjs test_long_routes.cjs test_candidate_distances.cjs test_tour.cjs test_walk_features.cjs test_discovery.cjs test_navigation.cjs test_geolocation.cjs test_route_nearby.cjs test_natural_discovery.cjs test_place_photos.cjs test_place_identity.cjs
.\.venv\Scripts\python.exe -B -m unittest discover -q
```

明示的に実通信を再現する場合：`python -B benchmark_routing_policy.py --live`。通常はネットワーク無効。3つの固定Valhalla要求、キャッシュ再利用、ORSの固定地点要求（キーなしなら認証状態だけ）、公開health確認を行い、キーや現在地は表示しません。

## 運営者が行うこと

1. **投稿と提供元への確認**：[英文案](VALHALLA_DISCUSSION_DRAFT.md)を実際の公開版・利用規模に合わせて確認し、自分のGitHubアカウントでDiscussionsへ投稿。返答や追加条件に従う。コードが未デプロイなら案内中のpreparing／pending deploymentを残す。
2. **ORSの契約と位置情報用途**：HeiGITへ上記の現在地用途を確認し、プランの速度・日量・商用等の条件を自分のアカウントで確認。同じキーを他アプリが使う場合は合算し、必要ならアプリ側上限をさらに下げる。APIキーを公開しない。
3. **新URLの認証確認**：Renderの環境変数`ORS_API_KEY`を確認し、更新版を承認してデプロイ後、固定した公開地点で通常・予備・往復の検索を確認。キーをチャットやIssueへ貼らない。
4. **問い合わせ・ログ管理**：運営名とGitHub Issuesでの受付を確認し、必要な非公開連絡先を用意。Render等のアクセスログの保持期間・アクセス権を確認し、実態に合わせてポリシーを更新する。
5. **運用規模**：当面は単一Pythonプロセス／単一インスタンス。複数化、負荷増加、頻繁な再起動を伴う運用では、共通の制限・継続的な使用量把握・契約や別サービスの検討を先に行う。現在のRAM上限が再起動を越えた利用量を保証すると解釈しない。
6. **公開反映**：この差分をレビューしてからpush・デプロイ。Live Serverも更新後のPythonを起動・再起動し、Ctrl+F5でJavaScriptを更新する。本番でプライバシー・出典リンク・エラー・PC／スマホを再確認。

以前の元PNGの公開Git履歴は別の未解決事項です。本対応では履歴書換え・素材の許諾取得をしていません。[権利監査](RIGHTS_REVIEW.md)を参照してください。

作業中、ORSの重複した距離チェックを整理する案は、自動承認審査で上流負荷の保護を撤去する変更と判断され拒否されました。この整理は採用せず、送信前に6,000km超を拒否するチェックを両方維持しています。依頼されたAPI対応に未実装の部分を残す理由にはしていません。

## 変更ファイル

`api_limits.py`（共有制限）、`valhalla_service.py`（固定先中継・検証・識別・キャッシュ）、`walking_routes.py`（ORS新URL・共有制限）、`app.py`（中継・429・入力とOrigin・公開文書の配信）、`static/js/app.js`（中継通信・自動更新抑制）、`static/js/candidate-distances.js`（自動予算・手動操作）、HTML2入口・CSS・出典台帳／ページ・プライバシーポリシー、関連テスト、`benchmark_routing_policy.py`、既存`benchmark_long_routes.cjs`のローカル中継対応、`render.yaml`の単一プロセス注記、README・THIRD_PARTY_NOTICES・本報告・英文案。新しいライブラリは追加していません。

既存の長距離実通信ベンチマークも`http://127.0.0.1:8000/api/valhalla`を通ります。実行する場合は更新後のPythonサーバーを先に8000番で起動してください。通常のテストで長距離の実要求は再実行しません。


地図タップの指定はボタン操作時だけ `/locate` を1地点・検索上限200m・8秒で使用し、150m以内の徒歩アクセス可能な道を確認します。既存の改札内通路データも候補除外に使用します。端末内で最大32件・成功5分／候補なし30秒を再利用し、エラーは候補なしとして保存しません。15mを超える変更は確認してから適用し、過去のGPS履歴を送信しません。


山の候補選択では、選択した山の公開座標と半径15kmの範囲を既存Overpassへ送ります（クエリ7秒、最大161要素、表示候補30件）。失敗時は既存Photonへ登山口／五合目という検索語と選択した山の座標による位置バイアスを最大2回送ります（共有間隔1秒以上、各3秒）。全体16秒以内、候補キャッシュ最大24地点・5分。山頂の情報表示とカード距離のためのルートAPI呼び出しは行いません。登山口・五合目への経路は従来のValhallaリレー・利用制限・登山難易度0を維持し、条件の異なるORS予備検索へ切り替えません。


## 地域の表現による検索

地名を含む定型表現はPhotonの既存`/api/`で地域だけを照会する。位置未指定の川・森・海は出発地点を約100m単位に丸めて半径8kmを検索する（名前のない山周辺は先に実在する山をPhotonで選択）。山名を指定した周辺検索は最大30km。広い地域は地図で明示的に範囲を指定する。中心座標は検索範囲の指定にだけ使用する。

Overpassは地物形状と周辺歩道の2段階、各6.5秒、全体26秒。各段階では既存の最大2提供元（遅延時の予備を含む）と、中継の502等によるブラウザからの直接接続を再利用する。したがってネットワークへの実要求数は段階数より多くなり得るが、各段階の予算は延長せず無制限に再試行しない。最大48地物、徒歩確認12地物・16周辺範囲、8MiBの上流応答制限をクエリに指定。取得した実在道路のジオメトリと立入制限を既存の自然スポット処理で照合する。

地物検索の失敗時だけ、Photon `/reverse` に丸めた地域座標・半径・対象OSMタグ・最大48件を送る（1回、最大5秒）。共有間隔は1秒以上。入口が未確認の予備候補ではルートAPIを呼ばない。通常の施設名検索とAPIエンドポイント、ORS/Valhallaの設定は変更しない。Nominatim公開APIを追加しない。成功5分・空や部分失敗30秒・24組のブラウザメモリキャッシュに加え、既存の自然検索キャッシュ・Python中継キャッシュを再利用する。

地域検索の詳細形状確認は1地物1,200座標・周辺データ合計18,000座標までです。大きすぎる形状は情報表示にとどめ、中止・地図操作を妨げないようにします。


### 田舎寄りの周辺確認と未確認候補

既存Overpassによる田舎寄り判定は1回最大6秒（他の周辺条件は既存15秒）で、対象の候補は1回最大4地点です。時間・種類・方角が一致する実在候補は照会前に表示し、未確認の状態を保持します。正常に周辺データを得て判定できた候補だけを、関数の確認済み一致結果として返します。参考候補を確認済み一致や早期終了の達成数に含めません。通信失敗を空の周辺データとしてキャッシュせず、候補をすべて非表示にしません。未確認の参考表示は全体最大10件で、追加のAPIや新規データは利用しません。


## 近くの食事処検索

既存のOverpass（`https://overpass.private.coffee/api/interpreter` / `https://overpass-api.de/api/interpreter`）へ、現在地または指定した地図中心を約200m区画に丸めた2.2km相当の矩形範囲を送り、`amenity=restaurant|fast_food|food_court` を一括取得します。厳密な半径2kmで絞り、最大500要素を取得、重複除去後最大200件表示します。クエリ8秒、通信各10秒、自動再試行なし、最初の検索先が1秒で返らない場合のみ既存の予備先も利用します。10分キャッシュ、連打防止、中止後の古い応答の破棄を再利用します。料理・営業時間は登録値を表示するだけで、営業状況の確認ではありません。

データ出典：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)、[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)。検索結果は実行中に一時利用し、新しい外部データファイルとして同梱しません。カフェ検索・ルート検索の利用条件は従来どおり適用します。アイコンはコード内の線画SVGです。


### 食事処の代替取得（2026-11-22）

Overpassを優先し、1秒で返らない／失敗／有効な店舗なしの場合、既存の `https://photon.komoot.io/api/` へ3カテゴリを `include` で一括検索します。約200m区画に丸めた地点と2.2km相当の矩形、上限50件、既存検索と共有する1秒間隔、通信5秒。食事処では最大2つのOverpass提供元とPhoton各1回までとし、同じOverpassへの中継失敗直後の直接再送は抑止します。有効な結果の取得で残りのブラウザ通信を中止します（中継側はタイムアウトまで続く場合あり）。種類・区画別10分キャッシュ、半径2km判定、重複除去を適用します。両方正常な空応答の場合のみ候補なしとし、一方が取得失敗なら未確認扱いにします。ルート沿い検索の取得先は変更していません。

出典：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) / [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)、[Photon提供元と公開利用条件](https://github.com/komoot/photon#demo-server)、[API公式仕様](https://github.com/komoot/photon/blob/master/docs/api-v1.md)。公開サービスの利用は合理的な回数に制限され、網羅性・可用性の保証はありません。新規APIキー・有料API・同梱店舗DBは追加しません。
