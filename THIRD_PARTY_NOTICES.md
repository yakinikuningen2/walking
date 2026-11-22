# 外部データ・ライブラリの利用条件

## 2026-11-16の公開API対応（追加）

ORSの移行案内に従い、固定エンドポイントを`https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson`へ更新しました。結果のCC BY-SA 4.0、HeiGITとOSMの帰属は維持します。ValhallaはPythonの固定先中継へ集約し、`X-Client-Id: walking-ctsh.onrender.com`を設定。複数利用者で共有する要求間隔・同時数・分／24時間予算、成功キャッシュ、429後の待機、自動検索の件数制限を追加しました。

実装・具体的な上限・検証・残る運営者の対応は[API利用対応報告](API_USAGE.md)、位置情報・保存・削除・接続先は[プライバシーポリシー](static/privacy.html)へ記載しています。[Valhallaへの英文通知案](VALHALLA_DISCUSSION_DRAFT.md)は作成しましたが、投稿していません。公開サーバーの許諾、ORSアカウントの契約、位置座標が個人データに当たる場合の取扱い、複数プロセス運用は運営者の確認が残ります。ポリシーの設置やブラウザ許可は、提供元の禁止事項を解除するものではありません。過去Git履歴の元PNGの問題も、このAPI対応で解決したものではありません。

## 2026-11-16の最終再確認

現行の同梱データ8区分・140ファイル、出典台帳、画像、API、ライブラリを再確認しました。詳細と一次資料は[今回の監査報告](RIGHTS_REVIEW.md)に記録しています。出典表示を前提とする再配布条件は確認できていますが、公開Git履歴の元PNG2点、Valhalla公開デモの一般公開時の連絡依頼、ORSの契約・現在地等の送信条件、Private.coffeeの個人識別可能情報を送らない条件について、対応・追加確認が残っています。

元PNGの旧SHA URLへ2026-11-16にHEAD要求を送り、両方ともHTTP200・image/pngを再確認しました。現行の追跡ファイル・static配下にPNG等のラスター画像はなく、旧素材をアプリからは参照しません。`.gitignore`を任意のフォルダにある同名PNGにも適用するよう強化しました。履歴の書換え・リモートの変更・push・権利者への照会はしていません。

写真は旧版CC BY／CC BY-SAの作品名に関する条件（例：[CC BY 3.0の4(c)](https://creativecommons.org/licenses/by/3.0/legalcode.en)、[CC BY-SA 2.0の4(c)](https://creativecommons.org/licenses/by-sa/2.0/legalcode.en)）を確認し、作品名を写真下と拡大画面のクレジットへ追加しました。CommonsのObjectNameを優先し、未指定ならファイル名を保持します。明示された作品名を長さの都合で省略して採用せず、長すぎる場合は写真自体を除外します。著作者・個別帰属・ライセンス・出典・トリミングの注記は維持します。写真の肖像・商標等の権利と、Commonsのメタデータの真正性まで保証するものではありません。

ORSの規約はログインしない一時ブラウザで現行の動的本文を再確認しました。API結果のCC BY-SA 4.0、回数制限、個人データ送信禁止を再確認しています。Private.coffeeの[利用規約4節](https://overpass.private.coffee/)にも個人識別可能情報を含めない条件があります。位置座標は文脈によって個人を識別し得るため、単に氏名を送らないことや利用者の同意だけで条件を満たすとは判断しません。

同梱・写真・出典配信のPython49件、写真処理のJavaScript13件が成功しました。これらは技術的な確認であり、未確認の契約や権利について許諾取得済みという意味ではありません。プログラム全体のライセンスは引き続き未設定です。

## 長距離ルートの加工（2026-11-15）

既存のValhalla / FOSSGISとopenrouteserviceを利用します。キーなしの予備処理では、同じValhalla提供元のlocateでOSMの歩行者アクセスを確認し、最大16区間の取得済み経路だけを連続性検査後に結合します。中継道路が見つからない場合の周辺5km・10kmの追加確認は最大3地点・各半径4方向・追加2要求までとし、確認済みの道路座標だけを使用します。距離・時間はAPI値を合算し、地図のOSM・Valhalla帰属を維持します。ORSのAPIキーはPython環境変数だけから取得し、結果のCC BY-SA 4.0とHeiGIT帰属も維持します。新しい外部データ・ライブラリは同梱しません。

検証集計は `benchmarks/long-route-results.json`、取得元・仕様・加工・限界は `benchmarks/LONG_ROUTES.md`。生の経路・道路情報・画像・統合した全国DBは追加配布しません。将来、相当量の経路・道路を保存・加工した派生DBを公開する場合はODbLの再提供条件を適用します。

## 施設の重複排除（2026-11-15）

高尾山口駅の補足確認では、OSMの駅舎・駅ノードを照合し、バス停を独立した場所として明示しました。試験用に少数の名称・OSM ID・座標等を抜粋し、出典と加工は `benchmarks/TAKAO_AND_PHOTO_RECOVERY.md` に記載しています。写真は取得先ごとのタイムアウト時に既存の別手段を試し、手動再取得時に成功した照合応答を再利用しますが、採用時の座標・施設・著作者・ライセンス確認と共有キャッシュの期限・容量は維持します。

Photon／Overpass（© OpenStreetMap contributors、ODbL 1.0・個別コンテンツDbCL 1.0）と既存のWikidata（CC0 1.0）・GeoNames（CC BY 4.0）等の候補を、ブラウザで照合・統合します。元の同梱データは提供元別のまま保持し、結果にも提供元とIDを引き継ぎ、地図と出典ページの帰属を維持します。プログラム全体にデータのライセンスを一括適用しません。相当量の統合・派生DBを公開・再配布する場合はODbL等の条件を別途適用します。

検証集計は `benchmarks/facility-dedup-results.json`、取得元・加工・制約は `benchmarks/FACILITY_DEDUP.md` に記載しています。実APIの生応答、写真本体、全国を結合した索引は新たに同梱しません。合成比較の名称・座標はテスト用で、アプリの目的地データには追加しません。

確認日：2026-11-15（同梱物と現行実装を再監査）。個別の対象版・配布元の一次資料を確認した記録です。APIや素材の利用規約は、オープンデータのライセンスと別に適用されます。

## 2026-11-15の再確認結果

現在の同梱地理データ8区分・140ファイル（JSONとgzip）を出典台帳と照合しました。再配布可能な条件は確認できていますが、出典・加工表示・継承などの条件付きであり、権利上の問題が一切ないという保証ではありません。プログラム全体のライセンスは未設定です。

| 対象 | 一次資料で確認した条件 | 現在の扱い |
| --- | --- | --- |
| 鉄道2025年度版 | [個別ページ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html)に2020年以降CC BY 4.0と明記 | 提供元・対象版・加工を表示。加工済み索引とgzipを同梱 |
| バス停2022年度版 | [個別ページ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P11-v3_0.html)のオープンデータ指定、[現行サイト規約](https://nlftp.mlit.go.jp/ksj/other/agreement.html)、[PDL1.0 1.7(3)](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0)のCC BY互換規定 | 2022年度版だけを使用。旧版の条件を流用しない |
| 東京都トイレ | [対象配布ページ](https://ckan.hokonavi.go.jp/dataset/facility_tokyo_bf-toilet)がPDL1.0を指定 | CC BY互換規定に従う。写真は含めず、原提供元と変換・追加加工を表示 |
| Wikidata地点索引・神社索引 | [構造化データはCC0](https://www.wikidata.org/wiki/Wikidata:Licensing) | 日本語名・分類・座標等の構造化データのみ。記事本文・写真は含めない |
| GeoNames地点索引 | [配布README](https://download.geonames.org/export/dump/readme.txt)のCC BY 4.0 | GeoNamesの帰属・加工・ライセンスを表示 |
| 桜・紅葉の編集データ | [Wikimedia利用規約7節](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content)とCC BY-SA 4.0。Wikidata座標はCC0 | 原記事・対象版・著者履歴案内を保持し、Wikipedia由来の編集を同条件で提供。写真なし |
| OSM通行除外範囲 | [ODbLとDbCL](https://www.openstreetmap.org/copyright) | 加工データを分離し、帰属・ライセンス付きの同じJSONを公開取得可能にする |

今回補った点は、スマホのシートに隠れない地図帰属表示、季節名所のWikipedia帰属、openrouteservice結果のCC BY-SA 4.0、Valhallaへの識別ヘッダー、アプリ内のサービス別条件・Pythonライブラリ一覧、[LeafletのBSDライセンス全文](static/licenses/leaflet-1.9.4.txt)です。OSM帰属は地図上に常時表示し、他の出典が増えた場合もOSMと出典ページへのリンクを先頭に維持します。自動試験の背景タイルは固定応答へ差し替え、公開タイルを自動巡回しません。

検証結果：JavaScript 158件・Python 48件、計206件の自動テストが成功しました。同梱JSON・gzipの台帳一致と展開後の同一性、サービス別ライセンス、BSD本文の公開配信、Valhallaだけに識別ヘッダーを付けることを確認しています。Chromeの1440×900、390×844、320×568、844×390で、地図・検索・登録・設定・周遊の通常／展開状態でもOSMリンクが実際に押せること、出典一覧8区分・外部サービス8区分・BSD本文が表示できることを確認しました。スマホの右下検索ボタンも押せます。ValhallaのOPTIONS確認ではHTTP 204、`Access-Control-Allow-Headers: Content-Type, X-Client-Id`を確認し、識別ヘッダー追加によるCORSの可否を切り分けました。APIキーや利用者の座標はこの外部確認に送っていません。実機Safari、公開Renderの再デプロイ後の試験は含みません。

### 未解決・運営者による追加確認が必要な点

1. **公開GitHubの過去版から元PNG2点を取得できます。** 現行ファイル・追跡対象にはありませんが、`d93b9ec`で`search_simple.png`、`e74510e`で`地図マーカーのアイコン素材4.png`が追加され、`55dbadc`で削除されています。2026-11-15、これらの完全なコミットSHAとパスを使った`raw.githubusercontent.com/yakinikuningen2/walking/…`へのHEAD確認で、両方ともHTTP 200・Content-Type `image/png`でした。利用規約の素材単体の再配布禁止は[ちょうどいいイラスト](https://tyoudoii-illust.com/利用規約/)・[ICOON MONO](https://icooon-mono.com/license/)で再確認しました。アプリへの組み込み許可と、素材原本を公開Git履歴から取得できる状態は分けて考える必要があります。許諾取得または公開履歴からの除去等の対応が必要です。今回、履歴書換え・force pushは行っていません。全ブランチ・タグ・fork・キャッシュまで除去済みとは確認しておらず、履歴を書き換えるだけで古いSHA URLが直ちに取得不能になる保証もありません。
2. **Valhalla公開デモの一般公開時の連絡依頼。** [公式README](https://github.com/valhalla/valhalla#demo-server)には、一般利用者向けアプリ公開時にGitHub Discussionsで知らせ、`X-Client-Id`を付ける依頼があります。後者は実装しました。運営者に代わる投稿や連絡は行っていません。[FOSSGIS提供元の公開説明](https://routing.openstreetmap.de/about.html)では帰属、地図修正リンク、最大1リクエスト/秒、大量利用禁止を確認しました。ブラウザ内の1秒制限は、複数利用者・複数タブ・サーバー全体の利用量まで保証しません。公開規模・商用利用を無条件に許諾済みとは判断しません。
3. **openrouteserviceの個別契約と座標の扱い。** [現行アカウント規約](https://account.heigit.org/info/tos)は通常のテキスト取得では読めなかったため、2026-11-15にログインしていない一時ブラウザで動的本文を確認しました。Attribution and License節でAPI結果のCC BY-SA 4.0と帰属、Usage Limits節で回数・速度の制限とアカウント条件を確認しています。個別アカウントの契約プラン・上限までは確認していません。また、Prohibited Conduct節には個人データの送信禁止があります。本アプリは出発地点・目的地・経由地の座標を送ります。現在地などの座標が状況によって個人データに該当する可能性について、運営者側で適用を確認する必要があります。「名前やIDを送らない」「利用者の同意がある」だけで規約上の禁止が解除されるとは判断しません。[運営者の説明](https://ask.openrouteservice.org/t/free-plan-in-an-app-with-a-paid-tier-license-cc-by-sa-4-0-personal-data-and-attribution-questions/8079)でも座標が個人データに当たるかは一律に判断していません。この確認を理由に機能を無断削除したり、外部へ照会を送ったりはしていません。
4. **FOSSGIS・共有APIの運用条件全文。** [FOSSGISの現行規約](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/)は今回アクセス拒否で全文未確認です。公式の概要・Valhalla READMEで確認できた条件と、未確認部分を区別します。[Photonの公式デモ利用条件](https://github.com/komoot/photon#demo-server)は合理的な利用量に限定し、大量利用の停止・変更・無保証を明記しています。Overpassも提供元ごとに運用条件があり、データのODbLだけでサーバーを無制限に利用できるわけではありません。

UIの独自SVG・CSS、現在の追跡ファイル、出典とライセンス表示を確認した範囲の技術的な監査です。公開済みサイトの全版、第三者による転載、商標・特許・各素材の制作経緯まで包括的に法的保証するものではありません。

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

2022年度版は個別ページでオープンデータと指定されています。現在の[サイト利用規約](https://nlftp.mlit.go.jp/ksj/other/agreement.html)はPDL1.0を採用し、[PDL1.0の1.7(3)](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0)はCC BYに従う利用を許諾しています。本アプリでは[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)に従って利用・再配布します。非商用等の別条件が示された2010年度版は使用しません。

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

## openrouteserviceのAPI結果

API結果には、[現行API規約](https://account.heigit.org/info/tos)で確認したCC BY-SA 4.0を適用します。地図では **© openrouteservice by HeiGIT** と **© OpenStreetMap contributors** の帰属、結果のライセンスリンクを表示します。規約の指定する **© openrouteservice by HeiGIT | Data from OpenStreetMap** に対応する表記です。基礎地図のODbLだけでAPI結果の条件を説明しきったことにはしません。結果の加工・再配布はCC BY-SAの条件に従い、独自プログラム全体や利用者の記録を同じライセンスへ一括変更しません。

## ライブラリ・外部サービス

ライブラリ本体をリポジトリへコピーせず、CDNまたは`requirements.txt`から読み込み・インストールします。原配布の著作権表示・LICENSEを保持します。Leaflet 1.9.4は[原文](https://raw.githubusercontent.com/Leaflet/Leaflet/v1.9.4/LICENSE)と同じBSD本文・著作権表示を`static/licenses/leaflet-1.9.4.txt`にも置きます。地図上のLeafletロゴ表示を外しても、これらのソフトウェアの告知は削除しません。

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

## GPS計測のカロリー算定方法（2026-11-16追加）

消費カロリーの計算方法は[横浜市スポーツ医科学センター](https://www.yspc-ysmc.jp/ysmc/column/health-fitness/run-1.html)の通常歩行の概算式を参照しています。数学的な算定方法のみ実装し、記事本文・写真・数値表は取得・同梱・再配布しません。GPS軌跡と任意の体重は端末内で処理します。この記事の権利をプログラム全体のライセンスとして扱いません。

## 目的地の写真（2026-11-15追加）

写真本体は同梱せず、Wikimediaの無料APIから個別の利用条件を確認して表示します。地点情報のライセンスを写真のライセンスとして扱いません。

- 提供元：Wikimedia Commonsの個別写真の著作者。関連付けにWikidata・Wikipedia・OpenStreetMapを利用します。
- 取得元：[Commons API](https://commons.wikimedia.org/w/api.php)、[Wikidata API](https://www.wikidata.org/w/api.php)、[日本語Wikipedia API](https://ja.wikipedia.org/w/api.php)、[英語Wikipedia API](https://en.wikipedia.org/w/api.php)。実際のファイルページを写真ごとにリンクします。
- 対応ライセンス：CC BY／CC BY-SA 1.0・2.0・2.5・3.0・4.0、[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)、[Public Domain Mark 1.0](https://creativecommons.org/publicdomain/mark/1.0/)。写真ごとの正確なライセンスURLをアプリ内に表示し、著作者名、APIのCredit・Attribution、元ファイルページへのリンクを保持します。
- 加工：APIの縮小画像を16:9の枠でトリミング表示し、加工内容を明記します。拡大画面では画像全体を表示します。CC BY-SAの条件は該当写真・その加工に適用され、アプリのプログラム全体のライセンスへ置き換えません。
- 照合の補足：Wikipediaのリダイレクト・住所フィールド、Wikidataのラベル・別名・P373、施設専用Commonsカテゴリを使います。Wikipediaの本文（CC BY-SA 4.0）は照合中だけ一時取得し、本文を表示・同梱・キャッシュ配布しません。利用する所在地等の事実と写真自体の利用条件を区別します。写真はCommonsの個別条件を引き続き確認します。
- 高速化の補足：縮小画像を320px指定で取得し、撮影者・ライセンス・出典・表示上の加工内容を維持。照合用API応答（住所確認用の本文を含む場合あり）はサーバー内メモリで最大10分／96件／6MiBまで共有しますが、本文や生API応答を利用者へ配布する機能はありません。各地点で照合を再実行し、写真なしからの明示的な再取得は共有キャッシュも使いません。タイムアウト等で確認が未完了だった場合の再取得は成功済み照合応答を期限内で再利用します。端末では成功した写真のURL・帰属等のメタデータと公開目的地の参照だけをsessionStorageに最大50件・元の24時間期限で保存し、失敗・未取得結果・訪問日・メモ・散歩履歴・画像バイナリは保存しません。
- 開発時の比較検証：`benchmarks/photo-results.csv` は既存のWikidata（CC0）・GeoNames（CC BY 4.0）・国土数値情報（CC BY 4.0）と、日本大学文理学部のPhoton/OSM地点（ODbL）の取得結果を評価した表です。座標の統合索引、写真バイナリ、記事本文、生のAPI応答は同梱しません。各提供元の取得版・出典・加工は既存のデータ台帳と `benchmarks/PHOTO_BENCHMARK.md` を参照してください。撮影者・画像の出典はCSVの個別URLから確認できます。
- 除外：利用条件不明、著作者情報不明、非商用限定、特別なRestrictionsのある画像、任意の外部画像URL、Commons外のWikipediaローカル画像。再利用条件を確認できなければ表示しません。フリー画像でも人物・商標など別の権利まで一律に保証されるものではありません。
- [再利用案内](https://commons.wikimedia.org/wiki/Commons:First_steps/Reuse)、[API利用ガイドライン](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines)、[User-Agent方針](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)を確認。最大2件同時、外部呼び出し間隔250ms、タイムアウト・429/503の待機を実装。メタデータのキャッシュだけを行い、写真バイナリはリポジトリに追加しません。


## 実行時の山・登山口・五合目の候補

既存のOverpass APIとPhoton APIから取得するOpenStreetMapの要素を、実行時の候補選択に使用します。提供元：OpenStreetMap contributors。取得元：<https://overpass.private.coffee/api/interpreter>、<https://overpass-api.de/api/interpreter>、<https://photon.komoot.io/api/>。ライセンス：Open Database License 1.0（<https://opendatacommons.org/licenses/odbl/1-0/>）。出典・利用案内：<https://www.openstreetmap.org/copyright>。加工：候補分類、名前・座標・OSM IDの保持、制限のある候補の除外、重複排除、表示件数制限、短期メモリキャッシュ。選択画面に出典・ODbLと各OSM要素へのリンクを表示します。新しいOSM抽出データベースをGitHubに同梱する処理はありません。プログラム自体のライセンスとは区別します。


## 地域の表現による場所検索（2026-11-21）

- 提供元：© OpenStreetMap contributors。検索・加工データは [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)、帰属と権利の案内は [OpenStreetMap著作権ページ](https://www.openstreetmap.org/copyright)。プログラム自体のライセンスとは別。
- 取得元：既存の [Photon / komoot](https://github.com/komoot/photon)（地域の特定・Overpass失敗時の周辺検索）および `https://overpass.private.coffee/api/interpreter`、`https://overpass-api.de/api/interpreter`（地図要素・形状・周辺道路・アクセス制限）。[Overpassの公開利用指針](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)と各提供元の条件に従う。Nominatim公開APIは新規導入しない。
- 加工：定型表現の地域・条件抽出、範囲・タグの絞り込み、重複排除、既存の歩行アクセス判定、OSM IDへの出典リンク。地図要素の座標から施設・自然地形・眺望を生成しない。
- 上限：最大30km・48要素、確認対象12要素・16周辺範囲、表示16件。地図検索2段階・各6.5秒・全体26秒以内。既存の最大2提供元と中継失敗時の直接接続を再利用し、無制限リトライはしない。Photonは必要時だけ、共有1秒間隔、取得失敗時の周辺検索1回。キャッシュを優先する。
- 保存：ブラウザの短期メモリキャッシュと既存中継の短期キャッシュだけを利用し、新たなODbLデータベースや生データをリポジトリへ同梱しない。アプリ内「出典・ライセンス」および地図・候補のOSMリンクから出典を確認できる。


## 近くの食事処検索

既存のOverpass（`https://overpass.private.coffee/api/interpreter` / `https://overpass-api.de/api/interpreter`）へ、現在地または指定した地図中心を約200m区画に丸めた2.2km相当の矩形範囲を送り、`amenity=restaurant|fast_food|food_court` を一括取得します。厳密な半径2kmで絞り、最大500要素を取得、重複除去後最大200件表示します。クエリ8秒、通信各10秒、自動再試行なし、最初の検索先が1秒で返らない場合のみ既存の予備先も利用します。10分キャッシュ、連打防止、中止後の古い応答の破棄を再利用します。料理・営業時間は登録値を表示するだけで、営業状況の確認ではありません。

データ出典：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)、[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)。検索結果は実行中に一時利用し、新しい外部データファイルとして同梱しません。カフェ検索・ルート検索の利用条件は従来どおり適用します。アイコンはコード内の線画SVGです。


### 食事処の代替取得（2026-11-22）

Overpassを優先し、1秒で返らない／失敗／有効な店舗なしの場合、既存の `https://photon.komoot.io/api/` へ3カテゴリを `include` で一括検索します。約200m区画に丸めた地点と2.2km相当の矩形、上限50件、既存検索と共有する1秒間隔、通信5秒。食事処では最大2つのOverpass提供元とPhoton各1回までとし、同じOverpassへの中継失敗直後の直接再送は抑止します。有効な結果の取得で残りのブラウザ通信を中止します（中継側はタイムアウトまで続く場合あり）。種類・区画別10分キャッシュ、半径2km判定、重複除去を適用します。両方正常な空応答の場合のみ候補なしとし、一方が取得失敗なら未確認扱いにします。ルート沿い検索の取得先は変更していません。

出典：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) / [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)、[Photon提供元と公開利用条件](https://github.com/komoot/photon#demo-server)、[API公式仕様](https://github.com/komoot/photon/blob/master/docs/api-v1.md)。公開サービスの利用は合理的な回数に制限され、網羅性・可用性の保証はありません。新規APIキー・有料API・同梱店舗DBは追加しません。
