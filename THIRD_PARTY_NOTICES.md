# 外部データ・ライブラリの利用条件

確認日：2026-11-12。個別の対象版・配布元の一次資料を確認した記録です。APIや素材の利用規約は、オープンデータのライセンスと別に適用されます。

## プログラムとの区別

このリポジトリには、独自プログラム全体の利用許諾を定める `LICENSE` がありません。GitHubで閲覧できることや、下記データのCC BY・CC BY-SA・ODbLによって、プログラム全体が同じ条件で再利用可能になるわけではありません。プログラムの包括的なライセンスの選択は著作権者が別途行います。利用者が入力する記録・コメントにも、これらの外部データのライセンスを一括適用しません。

## 同梱データ

| データ・ファイル | 提供元・取得元 | ライセンス・利用条件 | 加工 |
| --- | --- | --- | --- |
| 鉄道2025年度版：`static/stations-jp-2025-v1.json`、同`.gz` | 国土交通省：[N02-2025](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 駅区間の中点化、公式グループの代表駅採用、路線・会社の集約、索引化・圧縮。10,234地物→9,046組。基準日2025-12-31。出典と加工を明示し、政府の推奨と誤認させない。 |
| 季節名所：`static/seasonal-places.json` | Wikipedia contributors：[桜の一覧](https://ja.wikipedia.org/wiki/日本さくら名所100選)、[紅葉の一覧](https://ja.wikipedia.org/wiki/日本紅葉の名所100選)、各地点の`coordinateSource`。一部座標はWikidata contributors。 | Wikipedia由来の編集・分類は[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。Wikidataの構造化データは[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)、[公式方針](https://www.wikidata.org/wiki/Wikidata:Licensing)。 | 名称・分類・所在地・座標を編集。本文・写真なし。ファイル全体のWikipedia由来編集部分をCC BY-SA 4.0で再提供し、原記事へのリンク・著者履歴案内・加工を記録する。すべてをCC0とは表示しない。 |
| 通行除外・入口：`static/route-access.json` | © OpenStreetMap contributors。[原通路](https://www.openstreetmap.org/way/1252371411)。[西武鉄道の案内](https://www.seiburailway.jp/railway/station/akitsu/)は事実確認用。 | データベース：[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)、個別コンテンツ：[DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/) | OSM形状・座標を参考に、回避範囲と入口候補を選定した加工DB。ODbLと出典をJSON内に記録し、加工後JSON自体も公開URL `/static/route-access.json` で取得可能。構内図・説明文はコピーしない。 |

出典表示はREADME、`static/data-licenses.json`、アプリ内の「出典・ライセンス」から確認できます。駅を表示した場合の簡易クレジットも維持します。

## OpenStreetMapの利用状況

参照：[著作権ページ](https://www.openstreetmap.org/copyright)、[帰属表示ガイドライン](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)、[ODbL本文](https://opendatacommons.org/licenses/odbl/1-0/)。

- 背景地図は `tile.openstreetmap.org` から取得します。表示を `© OpenStreetMap contributors` とし、著作権ページへリンクします。ライセンス詳細への常設リンクも追加しました。帰属表示は検索・ルートのOSM由来データにも対応します。
- Photon・Overpass・Valhalla・openrouteserviceの結果は、APIソフトウェアのMIT・Apache・GPL等と、基礎地図のODbLを区別します。API経由だから出典不要とは扱いません。
- 全国OSM抽出・背景タイル・外部検索キャッシュはGitHubの同梱ファイルにはしていません。ブラウザの個人履歴・一時キャッシュと、公に配布するデータベースは区別します。
- 今回のOSM由来加工DBは `route-access.json` として分離し、ODbLで同じ加工データを取得できるようにしました。今後、相当量のOSMデータやそれを補正・結合した派生DBを公開利用・配布する場合は、ODbLの継承・機械可読データ再提供・告知条件を適用します。APIで数件を返すだけでこの義務を代替できるとは判断しません。
- CC BY・CC0のデータとは取得元・ファイル・DBを分け、結合内容によって派生DBになる場合は個別に条件を確認します。「別ファイルなら必ず継承不要」とは判断しません。プログラム全体へODbLを適用するものでもありません。
- [タイル利用規約](https://operations.osmfoundation.org/policies/tiles/)はデータライセンスと別です。現状は通常の対話表示で、オフライン用一括取得・タイルの同梱・キャッシュ無効化はしていません。WebのRefererとHTTPキャッシュを維持します。公開サービスの無制限利用・可用性を保証するものではありません。

## 配布対象から外す素材・出典

- `search_simple.png`：ユーザーから取得元として[検索欄のイラスト](https://tyoudoii-illust.com/7309/)の申告あり。[ちょうどいいイラスト利用規約](https://tyoudoii-illust.com/利用規約/)ではクレジット不要・加工可ですが、素材自体・加工素材の再配布は禁止されています。検索欄の枠と虫眼鏡は独自の`static/images/search-window.svg`へ変更しました。
- `地図マーカーのアイコン素材4.png`：同名の[ICOON MONO素材](https://icooon-mono.com/10167-地図マーカーのアイコン素材4/)と[利用規約](https://icooon-mono.com/license/)を確認。アプリへの組み込みは可能ですが、素材そのものの再配布は禁止です。原本の公開同梱を避け、独自SVG描画へ変更します。既存PNGの取得経緯まで独立に証明するものではありません。
- 元PNG2点はGitの追跡対象・新しい配布対象から外し、ユーザーの指示によりローカルからも削除しました。過去のコミット・公開済みコピーは今回の作業では書き換えていません。
- 季節名所のGO TOKYOにだけ依存した5地点と、同サイトにだけ依存した紅葉分類を公開用データから除外します。GO TOKYO・日本さくらの会のウェブサイトに一般的なデータ再配布許諾があると推定しません。残す編集データは再利用可能なWikipediaの一覧・個別記事を出典とします。元の混在データ全体を、後からCC0と表示することはしません。
- 画像の「クレジット不要」という申告を、素材ファイルの再配布許諾へ読み替えません。新規のSVGは本プロジェクトで作った図形で、これらの素材データの転用・トレースはしません。

## ライブラリ・外部サービス

ライブラリ本体をリポジトリへコピーせず、CDNまたは`requirements.txt`から読み込み・インストールします。原配布の著作権表示・LICENSEを保持します。

| 名前 | 条件・公式ライセンス |
| --- | --- |
| Leaflet 1.9.4 | [BSD-2-Clause](https://github.com/Leaflet/Leaflet/blob/v1.9.4/LICENSE)。Copyright 2010–2023 Volodymyr Agafonkin、2010–2011 CloudMade。CDNの原ファイルを利用。 |
| requests 2.34.2 | [Apache-2.0](https://github.com/psf/requests/blob/main/LICENSE) |
| urllib3 2.8.0 | [MIT](https://github.com/urllib3/urllib3/blob/main/LICENSE.txt) |
| charset-normalizer 3.5.2 | [MIT](https://github.com/jawah/charset_normalizer/blob/master/LICENSE) |
| idna 3.20 | [BSD-3-Clause](https://github.com/kjd/idna/blob/master/LICENSE.md) |
| certifi 2026.10.19 | [MPL-2.0](https://github.com/certifi/python-certifi/blob/master/LICENSE)、証明書バンドルを含む。改変配布時の条件に注意。 |

Pythonパッケージの版・ライセンスは、インストール済み配布物のメタデータでも確認しました。Photon、Overpass、Valhalla、openrouteserviceは外部サービスとして利用し、本体を配布していません。認証・レート制限・API利用条件は各提供者の条件に従い、APIキーはPython環境変数にのみ置きます。

## 今後の追加手順

1. 取得元URL、提供元、対象版、ライセンス名・URL、加工内容、取得日、ハッシュ、件数・容量を確認する。
2. CC BY 4.0、CC0等を優先する。「無料」「商用可」だけで再配布自由と判断しない。旧版と最新版の許諾差にも注意する。
3. 再配布不可・不明・第三者権利未確認のファイルは同梱しない。調査用の原本はリポジトリ外または無視対象の`data-raw/`へ置く。
4. README、今回の文書、`static/data-licenses.json`を更新し、アプリ内のリンクと加工済みファイルの出典をテストする。
5. ODbL派生DB等の再提供条件を満たす配布物を用意し、プログラムのライセンスとは区別する。

## 今回の検証

- `node --check static/js/app.js`
- `node --test test_navigation.cjs test_discovery.cjs`：36件成功。
- `.\.venv\Scripts\python.exe -B -m unittest test_data_licenses test_station_index test_walking_routes test_park_search -q`：計40件成功。
- PC幅1000px・スマートフォン幅320pxのChrome試験で、検索ボタンのクリック、検索候補、SVGマーカー、常設出典リンク、出典3件の表示、出典一覧の取得失敗時の案内を確認。横方向のはみ出し・JavaScript例外なし。
- スマートフォンのキーボードを想定して表示領域を狭めた試験で、名前・条件検索の入力欄、GPS・速度・スタート地点の変更後の候補保持を確認。権利整理後のデータに合わせ、東京周辺の試験対象は桜を使用。
- Gitの現行インデックスに元PNG2点が含まれないことを確認。元PNG2点はその後ユーザーの指示でローカルからも削除。過去コミットからの除去・GitHubへの反映・Render再デプロイは実施していない。
