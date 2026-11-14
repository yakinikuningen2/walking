# 外部データ・ライブラリの利用条件

確認日：2026-11-13（条件検索用のWikidata・GeoNames索引を追加）。個別の対象版・配布元の一次資料を確認した記録です。APIや素材の利用規約は、オープンデータのライセンスと別に適用されます。

## プログラムとの区別

このリポジトリには、独自プログラム全体の利用許諾を定める `LICENSE` がありません。GitHubで閲覧できることや、下記データのCC BY・CC BY-SA・ODbLによって、プログラム全体が同じ条件で再利用可能になるわけではありません。プログラムの包括的なライセンスの選択は著作権者が別途行います。利用者が入力する記録・コメントにも、これらの外部データのライセンスを一括適用しません。

## 同梱データ

### 条件検索用のWikidata地点索引

提供元：Wikidata contributors。[Query Service](https://query.wikidata.org/sparql)から2026-11-13に取得した構造化データです。[Wikidataの公式利用方針](https://www.wikidata.org/wiki/Wikidata:Licensing)に従い、[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)で利用・加工・再配布します。名称・分類・QID・座標を抽出し、種類内でQID集約、座標丸め、日本域外・座標不明・解散日（P576）または公式閉鎖日（P3999）ありの除外を行っています。日本語ラベルがあるものに限定し、記事本文・写真・他名前空間の文章を転載していません。

`static/discovery-wikidata-jp-2026-11-13-v1/`の8種類5,132レコードを同梱します。山頂Q207326、公園Q22698、植物園Q167346、街区Q123705、美術館・博物館Q33506、画廊Q1007870、カフェQ30022、レストランQ11707、商業施設Q11315、スーパーQ180846、城Q23413、展望塔Q1440300の取得済み分類を使います。直接分類と下位分類を含む問い合わせの違いは各JSONの`query`で確認できます。全国の全施設を網羅するものではありません。個別出典は`https://www.wikidata.org/wiki/`に各行のQIDを連結して確認できます。

提供元名・出典・加工・ライセンスはREADME、アプリの「出典・ライセンス」、JSONに記載し、読み込み後は地図にも簡易クレジットを表示します。JSON・索引計389,832バイト、gzip計130,909バイト。取得時点のクエリ・元応答のSHA-256は各種類のJSONに記録し、生成結果のSHA-256と件数は`index.json`に保持しています。

### 条件検索用のGeoNames日本語地名索引

提供元：GeoNames。[日本の地名ZIP](https://download.geonames.org/export/dump/JP.zip)（4,959,841バイト）と[日本向け別名ZIP](https://download.geonames.org/export/dump/alternatenames/JP.zip)（3,760,594バイト）を2026-11-13に取得しました。[配布元README](https://download.geonames.org/export/dump/readme.txt)と[公式サイトの利用条件](https://www.geonames.org/about.html)で[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)を確認し、加工後データも同じCC BY 4.0で再提供します。クレジットは **GeoNames（CC BY 4.0）を本アプリで抽出・分類・座標丸め・軽量化** です。README、アプリ内の出典、JSON、地図上のクレジットに反映しています。

原本103,767地物と341,848別名レコードを突き合わせ、言語`ja`・非歴史的・日本語表記のある名称を選びます。終了日付きの別名も除外します。対象はMT/PK（山・峰）、PPL/PPLL/PPLX（街並み・集落）、PRK（公園）、MUS（博物館）、OBPT/CSTL/MNMT（展望地点・城・記念物）、REST（食事）、MALL（商業施設）、TMPL（寺院）です。[分類の一次資料](https://www.geonames.org/export/codes.html)に従い、寺院の個別宗派や営業状況は推定しません。分類をアプリの検索種類へ対応付け、日本域外・対象外分類・日本語名不明を除外し、座標を小数6桁に丸めました。原典の明示された標高だけは保持し、DEM列・写真・紹介文は使用しません。

`static/discovery-geonames-jp-2026-11-13-v1/`の8種類50,764レコードを同梱します。JSON・索引計2,755,241バイト、gzip計792,687バイト。個別出典は`https://www.geonames.org/`に各行のIDを連結して確認できます。原本ハッシュは地名ZIPが`c118e2390410bc3df4cc266627698881b737925fc3815dbdb7da52b096e6fe4d`、別名ZIPが`c118a84e68d4644fc8cc2886c18b49d4a112eb2d4aa1527e84904b936f49e562`です。

両提供元のデータは別のファイル・別のライセンスで保持し、OSMのODbL派生DBへ混合しません。アプリで同時検索・重複整理しても、原本・加工物の利用条件をプログラムへ一括適用しません。現在の営業・入場可否や正確な入口は保証せず、地名の代表点は徒歩経路の存在を証明するものではありません。採用しなかったデータと理由は[調査結果](DATA_RESEARCH.md)に記載しています。

再生成は`python -B build_discovery_indexes.py 原本フォルダ`で行います。原本フォルダには2つのGeoNames ZIPと、`discovery-sources-2026-11-13/`内のWikidata取得応答を置きます。後者は`{"query": SPARQL文字列, "root": 分類QID, "kind": 検索種類, "data": JSON応答}`形式で、各ファイル名・固定SHA-256はスクリプトに記録しています。原本はリポジトリ外に保存し、ハッシュ不一致時は生成しません。更新時は出典・日付・分類・件数・ハッシュを再確認し、配布ファイル名の版とアプリ参照先も更新します。

### Wikidataの日本の神社索引

提供元：Wikidata contributors。[Query Service](https://query.wikidata.org/sparql)から2026-11-13取得。[神社（Q845945）](https://www.wikidata.org/wiki/Q845945)とその下位分類、日本（P17=Q17）、日本語ラベル、座標を条件とし、解散日（P576）ありを除外しました。[構造化データの公式利用方針](https://www.wikidata.org/wiki/Wikidata:Licensing)に従い、[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)で加工・再配布します。記事本文・写真・他名前空間の文章は使用しません。

取得応答17,156行から座標不明9行・日本域外・QID重複を除き、16,983地点のQID・日本語名・座標を収録。座標は小数6桁に丸めています。抽出クエリ・取得日・加工内容・原本SHA-256をJSONに保持し、個別出典は `https://www.wikidata.org/wiki/` にQIDを連結して確認できます。神社の網羅性・現在の参拝可否・正確な入口位置は保証せず、寺院はこの索引に含みません。

配布物：`static/shrines-jp-2026-11-13-v1.json`（895,084バイト）と`.json.gz`（284,422バイト）。原本は`{"query": SPARQL文字列, "data": SPARQLのJSON応答}`形式のUTF-8 JSON、SHA-256は`3adc7ba3bc0a19387fcb53bc4f09a6f09eb7f5a1f70c64b1cedcff34c1053567`です。`build_shrine_index.py 原本.json`で同じ索引を再生成できます。更新時は取得元・条件・ハッシュ・取得日・ファイル名の版を合わせて更新します。原本は同梱せず、OSM由来のODbLデータとは混合しません。プログラム全体にCC0を適用するものではありません。

| データ・ファイル | 提供元・取得元 | ライセンス・利用条件 | 加工 |
| --- | --- | --- | --- |
| 鉄道2025年度版：`static/stations-jp-2025-v1.json`、同`.gz` | 国土交通省：[N02-2025](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 駅区間の中点化、公式グループの代表駅採用、路線・会社の集約、索引化・圧縮。10,234地物→9,046組。基準日2025-12-31。出典と加工を明示し、政府の推奨と誤認させない。 |
| 季節名所：`static/seasonal-places.json` | Wikipedia contributors：[桜の一覧](https://ja.wikipedia.org/wiki/日本さくら名所100選)、[紅葉の一覧](https://ja.wikipedia.org/wiki/日本紅葉の名所100選)、各地点の`coordinateSource`。一部座標はWikidata contributors。 | Wikipedia由来の編集・分類は[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。Wikidataの構造化データは[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)、[公式方針](https://www.wikidata.org/wiki/Wikidata:Licensing)。 | 名称・分類・所在地・座標を編集。本文・写真なし。ファイル全体のWikipedia由来編集部分をCC BY-SA 4.0で再提供し、原記事へのリンク・著者履歴案内・加工を記録する。すべてをCC0とは表示しない。 |
| 通行除外・入口：`static/route-access.json` | © OpenStreetMap contributors。[原通路](https://www.openstreetmap.org/way/1252371411)。[西武鉄道の案内](https://www.seiburailway.jp/railway/station/akitsu/)は事実確認用。 | データベース：[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)、個別コンテンツ：[DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/) | OSM形状・座標を参考に、回避範囲と入口候補を選定した加工DB。ODbLと出典をJSON内に記録し、加工後JSON自体も公開URL `/static/route-access.json` で取得可能。構内図・説明文はコピーしない。 |

出典表示はREADME、`static/data-licenses.json`、アプリ内の「出典・ライセンス」から確認できます。駅を表示した場合の簡易クレジットも維持します。

### 全国バス停2022年度版

提供元：国土交通省。[取得元・対象版](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P11-v3_0.html)、[全国GML原本](https://nlftp.mlit.go.jp/ksj/gml/data/P11/P11-22/P11-22_GML.zip)。原本は9,031,560バイト、SHA-256は`e74da3736c56ddeb1f47c18d6e5f373f40fa7f3c7d695593029e8ac7a7f790d1`。

2022年度版は個別ページでオープンデータと指定されています。現在の[サイト利用規約](https://nlftp.mlit.go.jp/ksj/other/agreement.html)はPDL1.0を採用し、[PDL1.0の1.7(3)](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0)はCC BYに従う利用を許諾しています。本アプリでは[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)に従って利用・再配布します。再配布不可の2010年度版は使用しません。

配布物は`static/bus-stops-jp-2022-v1/index.json`と`01.json`〜`47.json`、各`.gz`です。278,515レコードから名称・座標・事業者・地物IDを抽出し、座標を小数6桁に丸め、都道府県別に分割・圧縮しています。JSON合計19,699,540バイト、gzip合計4,648,755バイト（索引を除く）。原本ZIPは同梱しません。再生成用の`build_bus_stop_index.py`は原本のハッシュを検証します。

出典表記：**「国土数値情報（バス停留所データ・2022年度）」（国土交通省）を本アプリで加工して作成**。地図上とアプリ内の出典一覧にも表示します。原典では同一道路の同名停留所などを集約しており、乗車側の正確な位置・現行の運行状況は保証しません。高速・デマンドバスは対象外です。OSM由来のデータベースとは分けて保持し、プログラム全体のライセンスへ一括適用しません。

### 東京都の施設内トイレ

提供元：東京都福祉局、変換・配布：国土交通省。[ほこナビDPの対象データ](https://ckan.hokonavi.go.jp/dataset/facility_tokyo_bf-toilet)、[東京都の原データ案内](https://www.fukushi.metro.tokyo.lg.jp/kiban/machizukuri/bf_data)、[ZIP原本](https://ckan.hokonavi.go.jp/dataset/3c4752a2-e24a-4886-a312-0cd0928e4247/resource/d2a43ef1-5233-4a50-9b47-27de1ecfea32/download/facility_tokyo_barrier-free_toilet.zip)。原典は令和6年度更新版、配布元のデータ更新日は2026-03-19。ZIPは2,589,157バイト、SHA-256は`65999b9535f87673a30f24a28b2f9eb54d1b215ae4cb4818d105dbca41189ec6`。

配布元が指定する[PDL1.0](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0)の1.7(3)により、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)に従って利用・再配布します。出典表記：**東京都福祉局の車椅子使用者対応トイレ情報（令和6年度更新版）を国土交通省が変換したデータを、本アプリでさらに加工して作成**。

`static/toilets-tokyo-2024-v1.json`と`.gz`を同梱します。5,692施設から、交通施設698件と座標不明137件を除いた4,857施設を収録します。施設名・施設座標・住所・設備の利用時間・備考を抽出し、施設単位に集約しました。写真・画像URLは収録しません。JSON 1,462,166バイト、gzip 322,287バイト。`build_toilet_index.py`で原本ハッシュを検証して再生成できます。

表示位置は施設の代表位置で、トイレ入口そのものではありません。公開資料に記載された利用時間・条件を保持し、現時点の開館・入場条件を保証するものではありません。全国の完全な公衆トイレ一覧として扱いません。CC BYの配布物はOSM由来DBと分離し、プログラムや利用者の記録全体のライセンスへ適用しません。

## OpenStreetMapの利用状況

### 自然スポットの徒歩アクセス検索（2026-11-13）

森・河川・湖沼・海岸・浜辺・港と、その周辺の歩道・入口・公園・立入制限を、既存の[Private.coffee](https://overpass.private.coffee/)と[Overpass API](https://overpass-api.de/)から取得します。提供元のソフトウェアのライセンスと、[OSMデータのODbL 1.0](https://www.openstreetmap.org/copyright)は区別します。APIの運用条件は[OSM公式の提供元一覧](https://wiki.openstreetmap.org/wiki/Overpass_API)を参照し、範囲・件数・実行時間・メモリ・再試行を制限します。OSMの出典表示をLeaflet上で維持し、候補のポップアップにも元の道へのリンクを表示します。

地形の中心を徒歩目的地として再配布するものではなく、取得した地形と道の形状から道上の候補を計算します。既知の立入制限を除外し、条件が未記入・条件付き、または周辺情報の取得が不完全な場合は未確認と表示します。OSM上の徒歩可タグは現地確認の証明とは扱いません。API生データは検索時の一時キャッシュ（10分）で、全国抽出・検証時の実データ・新しいOSM派生DBはリポジトリへ追加していません。利用者の既存の検索履歴には候補の名称・座標・アクセス注記・道の識別子が端末内に保存されますが、公開配信はしません。

将来、OSM由来の抽出・加工データベースを公開・再配布する場合は、[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)の出典・継承・加工DBの提供条件を適用し、個別コンテンツは[DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/)として扱います。CC0・CC BYの同梱索引や本アプリ独自プログラムのライセンスへ混同しません。

固定地点の実データ検証には、既存2提供元のタイムアウト／502を切り分けるため、[公式一覧掲載のVK Maps Overpass](https://maps.mail.ru/osm/tools/overpass/api/interpreter)も用いました。これは開発時の固定した公開地点だけの検証で、アプリの問い合わせ先へ追加していません。検証の生データは一時フォルダに保持し、GitHubへの同梱は行いません。

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
