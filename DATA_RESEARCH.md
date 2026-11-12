# 散歩アプリ向け公開データ調査

調査日：2026-11-12。追加候補のデータはアプリへ同梱していません。配布物を取得した場合もリポジトリ外の一時フォルダだけで調べています。出典表示・既存同梱データの是正は今回実施します。

## 推奨順

1. **全国バス停 P11-2022**：CC BY 4.0。278,515レコードを実測。SQLite化が適しています。
2. **駅別乗降客数 S12**：CC BY 4.0。2024年度の統計を含む配布物を確認。既存の駅索引へ属性として付加でき、追加する位置情報を抑えられます。
3. **座標と再配布許諾が確認できた自治体の公衆トイレ・公園**：地域から段階的に追加。全国が同一ライセンス・同一形式でそろうとは扱いません。
4. **湖沼 W09**：556地物で軽い候補。ただし2005年の古いデータで、CC BYではなく旧約款の「商用可」です。出典・加工表示を伴う複製物の再配布が許される対象であることを確認しました。
5. **観光・文化財・寺社**：自治体CC BYまたはWikidata CC0を優先。全国をまとめる場合はOSM由来データをODbL専用の配布DBとして分離する案があります。
6. **標高・傾斜**：最初は地域限定、または地理院の必要タイルだけ。全国の高解像度DEMをそのまま無料Renderへ載せる案は勧めません。

## 年度・件数・容量・条件

「配布表示」は提供元ページのMB表記をそのまま示します。提供元間で単位表記が一様ではないため、取得したファイルは実測バイトも示します。「レコード」は物理的な施設の重複除去後件数とは限りません。未公表・未集計は数値を推定で埋めていません。

| 対象 | 提供元・取得元URL | 条件 | 年度・基準 | 件数 | 元ファイル容量・判定 |
| --- | --- | --- | --- | --- | --- |
| 全国バス停 | 国土交通省 [P11 v3.0](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P11-v3_0.html)、[全国GML ZIP](https://nlftp.mlit.go.jp/ksj/gml/data/P11/P11-22/P11-22_GML.zip) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2022年度、概ね2022年8月 | **278,515 BusStop**（47都道府県のGMLを集計） | 配布表示9.03MB、実測**9,031,560 B**。SHAPE/GeoJSON版は表示39.20MB。**最優先**。高速バス・デマンドバスは対象外で、全種類の現行停留所網とは異なる。 |
| 公園：新しい全国系候補 | 国土交通省 [都市計画決定情報 A55-2024](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A55-2024.html)、[配布一覧JS](https://nlftp.mlit.go.jp/ksj/js/tokei_data2024.js) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2024年度版、自治体により原典時点が異なる | 公園レイヤだけの全国件数は未公表・未集計 | 47都道府県のGeoJSON ZIP表示合計**1,002.74MB**。都市計画全種類の容量で、公園だけの容量ではない。東京都全域は表示54.02MB。東村山市の742,680 Bのサンプルには公園レイヤがなく、全国公園網の代替と断定できない。**自治体別の収録範囲確認後に抽出**。 |
| 公園：旧データ | 国土交通省 [P13](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P13.html) | 非商用・旧約款では**複製物の再配布を除く** | 配布2011年、基準2010年3月 | 公式ページに全国総数なし。採用対象外のため未集計 | 47 ZIPの表示容量合計**6.08MB**、東京0.43MB。**GitHub同梱に不採用**。無料でも再配布可とは扱わない。 |
| 観光名所 | 国土交通省 [観光資源 P12-2014](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P12-2014.html)／代替例：[仙台市観光施設](https://www.city.sendai.jp/kankokikaku/opendata/kankoshisetsu.html)、[CSV](https://www.city.sendai.jp/kankokikaku/opendata/documents/041009_tourism.csv) | P12は非商用・複製物再配布不可。仙台市CSVは表示上**CC BY 4.0** | P12基準2014-09-30。自治体CSVの整備年度は固定の全国年度なし | P12全国件数未集計。仙台市CSVは**97行、緯度経度が数値の行0** | P12表示8.79MB。仙台市CSV実測**43,130 B**。P12は不採用。自治体例は座標不足のため、そのまま地図検索へ同梱しない。代わりに座標・許諾がそろう自治体データ、Wikidata CC0を検討。 |
| 公衆トイレ | デジタル庁 [自治体標準ODS](https://www.digital.go.jp/resources/open_data/municipal-standard-data-set-test)。実測例：[仙台市CSV](https://www.city.sendai.jp/joho-kikaku/shise/security/kokai/documents/041009_public_toilet.csv)、[宮城県共同カタログ](https://miyagi.dataeye.jp/resources/1388) | 個々の自治体で確認が必要。例は**CC BY 4.0** | 例のカタログ公開2025-02-21。CSV全体のデータ基準年月は明記を確認できず | 例：**742行、数値座標あり681行**。全国統一ファイル・総件数は確認できず | 例：**242,880 B**。**座標確認済み行の地域別同梱を推奨**。全国の完全なトイレ一覧とは表示しない。営業時間・利用条件も保持する。 |
| 文化財 | 国土交通省 [都道府県指定文化財 P32](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P32.html)／代替例：[仙台市](https://www.city.sendai.jp/bunkazai-kanri/kurashi/manabu/kyoiku/inkai/bunkazai/bunkazai/bunkazai.html)、[CSV](https://www.city.sendai.jp/bunkazai-kanri/kurashi/manabu/kyoiku/inkai/bunkazai/bunkazai/documents/041009_cultural_property.csv) | P32は非商用・複製物再配布不可。仙台市CSVは**CC BY 4.0** | P32基準2014-01-31。仙台市の案内は2025-04-01現在 | P32全国総数未確認。CSVは空行を除き**341行、数値座標あり0行** | P32表示1.93MB。仙台市実測**92,314 B**。P32は不採用。座標欠落を適当な市役所位置などで埋めない。画像・解説文は別権利として扱う。 |
| 神社・寺院 | [Wikidata Query Service](https://query.wikidata.org/)、[Wikidataライセンス](https://www.wikidata.org/wiki/Wikidata:Licensing)。別案：[OSM日本抽出](https://download.geofabrik.de/asia/japan.html)の宗教施設 | Wikidata構造化データは[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)。OSMは[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | 随時更新、採用時にスナップショット日時を固定 | 全国の寺社を網羅するCC0一括配布の確定件数は未確認。今回のWikidata集計クエリは35秒でタイムアウト | 個別抽出後容量は未測定。OSM日本全体PBFは確認時**2.4GB**（2026-11-11T21:22:47Zまで）。寺社だけの容量ではない。**取得条件・件数・サイズを確定してから採用**。OSM原本全体は同梱しない。 |
| 湖沼 | 国土交通省 [W09-2005](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-W09-2005.html)、[全国ZIP](https://nlftp.mlit.go.jp/ksj/gml/data/W09/W09-05/W09-05_GML.zip) | [旧利用約款準拠版](https://nlftp.mlit.go.jp/ksj/other/agreement_02.html)の**商用可**。複製物の再配布も許容、出典・加工表示が必要。CC BYとは表示しない | 基準2005-09-01 | **556地物**（DBFレコード実測） | 表示7.70MB、実測**8,082,201 B**。軽量化候補。ただし古さと湖岸の通行可能性に注意。水面の中心を徒歩目的地にしない。 |
| 駅別乗降客数 | 国土交通省 [S12・2024年度統計](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-S12-2024.html)、[S12-25 ZIP](https://nlftp.mlit.go.jp/ksj/gml/data/S12/S12-25/S12-25_GML.zip) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 整備・配布ファイル2025、統計基準2024年度まで。2026年4月更新案内 | **10,534レコード**。UTF-8・Shift-JISの重複を二重計上しない | 表示6.59MB、実測**6,913,743 B**。**優先候補**。非公開・重複集計・年度のコードを保持し、未公表を0人にしない。 |
| 標高・傾斜度 | 国土交通省 [G04-d・5次メッシュ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-G04-d.html)、[5339区画ZIP](https://nlftp.mlit.go.jp/ksj/gml/data/G04-d/G04-d-11/G04-d-11_5339-jgd_GML.zip) | [旧利用約款準拠版](https://nlftp.mlit.go.jp/ksj/other/agreement_02.html)の**商用可**。CC BYではない | 整備2011年度、基準2009-05-01（一部2008年） | 全国169配布区画。全国メッシュ総数未集計。5339区画は**93,504メッシュ** | 全国ZIP表示合計**286.34MB**、5339実測**4,194,280 B**。250mメッシュの地形傾斜で、道路上の勾配ではない。地域限定・必要属性だけの同梱から始める。 |

### 代替となる標高タイル

国土地理院の[標高タイル仕様](https://maps.gsi.go.jp/development/demtile.html)、[タイル一覧](https://maps.gsi.go.jp/development/ichiran.html)、[コンテンツ利用規約](https://web1.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)を確認しました。現行はPDL1.0と同機関の重要情報・測量法等の個別条件を確認する必要があり、一律CC0とは表示しません。256×256画素のタイルで地域・解像度・更新時点ごとに件数・容量が変わるため、全国一括サイズを今回推定していません。必要な地域のタイルを使う方式が現実的ですが、新しい外部通信先の追加は今回実装していません。

### 不採用・保留の理由

国土交通省の[旧利用約款第1条](https://nlftp.mlit.go.jp/ksj/other/agreement_02.html)では「非商用」の対象について、非商用利用でも複製物の再配布を除いています。したがって、P13・P12・P32の原本やそこからの抽出DBを、単に非営利のGitHubだからよいとして載せません。別年度のCC BYデータや自治体資料とは別に判断します。

全国統一のCC0/CC BYファイルが確認できない対象では、自治体ごとの許諾・座標有無の確認が必要です。Wikidataも完全な全国台帳ではなく、問い合わせ条件で件数が変わります。数値が未確認のものは、同梱準備完了とは扱いません。

## Render無料プラン向け構成案

参照：[無料サービス](https://render.com/docs/free)、[Compute Plans](https://render.com/docs/compute-plans)、[SQLite R*Tree](https://www.sqlite.org/rtree.html)、[FTS5](https://www.sqlite.org/fts5.html)。確認時のFreeは0.1 CPU・512MB RAM、15分無通信で停止し、ローカルの変更は再起動・再デプロイ・停止で失われます。無料Postgresも恒久的な無制限ストレージの代わりとは扱いません。

推奨フロー：

```text
既存の検索画面
  → 同梱JSON／読み取り専用SQLiteで検索・距離判定
  → 得られた候補を先に表示
  → 未収録地域・不足時だけ既存Photon／Overpass等へ期限付きで問い合わせ
  → source_idを保持して重複を整理、追加候補を表示
```

- 駅のように小さいデータは現在のブラウザ索引を維持。大量のバス停・施設を毎回ブラウザへ全件配信しない。
- オフラインで属性を絞ったSQLiteを作り、R*Treeで矩形候補を絞った後、実距離と徒歩時間・方向を判定する。DB全体をPythonの配列へ読まない。
- `place(id, kind, name, name_norm, lat, lon, source_id)` と、`source(id, provider, source_url, license, license_url, reference_date, modified, sha256)` を分ける。ポリゴン・湖岸形状は別表に置き、必要な候補だけ読む。
- 名前は正規化して索引化。FTS5の標準unicode61だけで日本語の単語分割ができるとは扱わない。3文字以上ならtrigram、短い語は前方一致のB-tree等を検討する。
- SQLiteは `mode=ro&immutable=1` で開き、接続数・ページキャッシュ・結果件数に上限を設ける。例：4接続以下、各キャッシュ2～8MB、API返却50件ずつ。値はRender上の実測後に調整する。
- DBを事前生成してデプロイに含める。無料Renderの書き込み領域を、データ更新や利用者の記録の永続保存先にしない。現在の利用者記録のブラウザ保存は維持する。
- 小さい原本は版付きgzip、大きい読み取り専用DBは事前生成・圧縮配布を検討。サービス起動時に毎回全国のZIPやPBFを展開・索引化しない。
- OSM由来DBとCC BY/CC0由来DBは出典・配布物を分ける。ODbL派生DBが公開対象になる場合は、対応する加工済みDB・ライセンスを機械可読で再提供する。プログラムのライセンスと混同しない。
- 「候補なし」と「取得失敗」を分ける。キャンセル・古い検索結果の破棄を維持し、外部応答が遅くても既に得た同梱候補を隠さない。

### SQLite試作の実測

**アプリには追加せず、一時フォルダでのみ実施。** P11の278,515件から、名称・緯度・経度とR*TreeだけのDBを生成しました。

| 項目 | 実測 |
| --- | --- |
| SQLite | 3.50.4、Python 3.13、Windowsローカル |
| DB容量 | **27,828,224 B** |
| 生成時間 | **5.53秒** |
| 秋津付近の矩形で抽出された行数 | 28行 |
| 50回の検索中央値／最大 | **0.312ms／1.583ms** |

これは温まったローカルファイルシステムで、読み取り専用接続・2MBページキャッシュによる**矩形候補抽出部分だけ**の計測です。実距離計算・HTTP・起動・表示時間や、Render上の性能を示すものではありません。運営会社・路線・出典列・全文検索を追加した最終DBは、この容量と同じにはなりません。

## 調査方法・検証記録

- 公式データページで対象版・利用条件・配布容量を確認。公開ZIPのDBFレコードヘッダやGMLのBusStop要素、CSVの空行を除いて数えました。
- S12は同じ内容の文字コード違いを二重計上しません。文化財CSVは343物理行ではなく、空行を除いた341レコードと記録しています。
- 自治体CSVは緯度経度欄が数値かを確認。名称があることだけで地図に出せるデータと判定しません。
- 配布ZIPのSHA-256（調査原本照合用）：P11 `e74da3736c56ddeb1f47c18d6e5f373f40fa7f3c7d695593029e8ac7a7f790d1`、S12 `0785e932a32b3ec15e1a1345537ae145eafe1c07bf38d5c16c11ee2b391e7a28`。
- 一時取得原本とSQLite試作はGitHubへ追加しません。新データを採用する場合は、別途対象版・更新手順・出典・ライセンスを登録してから実装します。
