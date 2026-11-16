# 権利・利用条件の最終再確認（2026-11-16）

**判定：現行の同梱物には再利用条件と出典を確認できたものを使っていますが、未解決事項が残ります。公開履歴・外部APIの運用条件まで含めて「問題なし」とは判定していません。**

これはソース・配布物・一次資料を照合した技術的な監査です。個別契約、第三者による無許可投稿、肖像・商標等、法的責任の不存在まで保証するものではありません。

## 対象と方法

- 現在の作業ツリー・Git追跡ファイル、HTML／CSS／JavaScript／Python、ライブラリと素材の読込先を確認。
- `static/data-licenses.json`の同梱データ8区分・140ファイル（JSON／gzip）を実ファイルと照合。gzipの展開後の同一性・出典配信も試験。
- 静的配布領域のPNG・JPEG・GIF・WebPは0件。追跡されている画像は独自描画の`static/images/search-window.svg`のみ。UIのインラインSVG・CSSも確認。外部のデザイン参考画像を背景に埋め込んでいません。制作経緯の独立した証明まで行ったわけではありません。
- 旧PNGについては公開URLにHEAD要求だけを送り、画像本体の取得・保存・再配布は行っていません。
- 公式サイトのライセンス・規約を再取得。ORSは動的表示のため、ログインしない一時Chromeで公開本文を確認。FOSSGIS規約の全文はアクセス拒否で未確認。
- APIキー・個人の位置情報は今回の外部確認に送信していません。Gitのリモート設定・履歴・ブランチは変更せず、pull／push／デプロイ／権利者への投稿・照会も行っていません。

## 同梱データの確認

| データ | 確認した条件 | 現行の処理・表示 |
| --- | --- | --- |
| 国土数値情報・鉄道2025年度 | [対象版の個別ページ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html)で2020年以降のCC_BY_4.0を確認 | 駅索引として抽出・軽量化。提供元・版・加工を台帳、README、アプリ内に表示 |
| 国土数値情報・バス停2022年度 | [対象版の個別ページ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P11-v3_0.html)のオープンデータ指定、[サイト規約](https://nlftp.mlit.go.jp/ksj/other/agreement.html)、[PDL1.0の1.7(3)](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0)のCC BY互換規定 | 再配布可能な2022年度版のみ。非商用の旧版へ条件を流用しない |
| 東京都・トイレ令和6年度由来の変換データ | [対象データセット](https://ckan.hokonavi.go.jp/dataset/facility_tokyo_bf-toilet)のPDL1.0、同互換規定 | 名称・代表座標・利用時間等を抽出。写真を含めず、原提供元と二段階の加工を表示 |
| Wikidata地点索引 | [構造化データのCC0](https://www.wikidata.org/wiki/Wikidata:Licensing) | QID・名称・分類・座標のみ。記事本文・写真をCC0扱いしない |
| Wikidata神社索引 | 同上 | 別ファイルで保持し、抽出・座標丸め・出典を表示 |
| GeoNames日本語地名索引 | [配布READMEのCC BY 4.0](https://download.geonames.org/export/dump/readme.txt) | 提供元・加工・条件を表示。独立した索引として再提供 |
| 桜・紅葉名所の編集データ | [Wikimedia規約7節のCC BY-SA 4.0](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content)、Wikidata座標のCC0 | 記事・対象版・著者履歴案内を保持。Wikipedia由来部分を同条件で提供。画像は同梱しない |
| OSM通行除外範囲 | [OSMのODbL／DbCL](https://www.openstreetmap.org/copyright) | `route-access.json`を分離し、加工と出典を告知し、同じ機械可読の加工データを公開取得可能にする |

出典・原版・加工・ライセンスの詳細は既存の`static/data-licenses.json`と`THIRD_PARTY_NOTICES.md`に保持します。提供元ごとのファイル分離だけで、将来の大規模な統合・補正DBが常にODbLの対象外になるとは判断しません。現在の端末内の検索・個人履歴と、公開配布する派生データベースは区別します。

## 写真・素材・ライブラリ

### 写真

Commonsの個別メタデータで、著作者、許容するCC BY／CC BY-SAの版・CC0・Public Domain、出典URLを確認できる画像のみ採用します。非商用条件・条件不明・追加制限等は採用しません。Commonsがすべての写真の権利を保証するわけではなく、[個別の権利状態と、肖像・プライバシー・商標などの著作権以外の制限](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)の留保は残ります。

今回、旧版CCの作品名の明示が不足していた点を修正しました。[CC BY 3.0の4(c)](https://creativecommons.org/licenses/by/3.0/legalcode.en)、[CC BY-SA 2.0の4(c)](https://creativecommons.org/licenses/by-sa/2.0/legalcode.en)を確認し、作品名を写真下と拡大画面に表示します。CommonsのObjectNameを優先し、未指定ならファイル名を表示。明示された長すぎる作品名を切り詰めて採用せず、画像を不採用にします。

著作者・Credit・Attribution・ライセンスへのリンク・ファイルページ・トリミング注記は維持。写真バイナリはGitHubに同梱しません。表示枠でのトリミングを含め、個々の画像の条件を維持し、アプリ全体のライセンスに置き換えません。

### 現行の画像とフォント

旧`search_simple.png`と`地図マーカーのアイコン素材4.png`は現行配布物・追跡対象から削除済みで、現行HTML／CSS／JSから参照していません。検索枠・マーカー・アイコンは現在のSVG／HTML／CSSによる描画です。CSSのNoto Sans JP等はフォント名を指定しているだけで、フォントファイルの同梱・外部フォントAPIの呼出しはありません。

### ライブラリ

- Leaflet 1.9.4：[BSD-2-Clause](https://github.com/Leaflet/Leaflet/blob/v1.9.4/LICENSE)。CDN版の著作権表示を維持し、`static/licenses/leaflet-1.9.4.txt`の全文もアプリから公開配信。
- インストール済み配布物のメタデータとLICENSE／NOTICEの存在を確認：requests 2.34.2はApache-2.0、urllib3 2.8.0とcharset-normalizer 3.5.2はMIT、idna 3.20はBSD-3-Clause、certifi 2026.10.19はMPL-2.0。ライブラリ本体の改変・リポジトリへのコピーはなし。再配布物を将来変更する場合はそれぞれの条件を維持する必要があります。
- アプリ独自プログラム全体のLICENSEは未設定。公開自体の禁止を意味しませんが、第三者への包括的な再利用許諾は定めていません。外部データのライセンスで代替せず、運営者が別途選択します。

## 残る対応：公開Git履歴の元PNG

2026-11-16のHEAD確認で、以下の旧SHA／パスから両方ともHTTP200・Content-Type image/pngを確認しました。現在のファイルを消しただけでは、公開履歴からの取得は止まっていません。

| ファイル | 取得できたコミット | パス |
| --- | --- | --- |
| search_simple.png | `d93b9ec97b0bd1a2aba4fa1876b9884ec16832c5` | `static/images/search_simple.png` |
| 地図マーカーのアイコン素材4.png | `e74510e3f092f791d3bfc8b1be8e6189e210c7a9` | `static/images/地図マーカーのアイコン素材4.png` |

公開URLの形式は `https://raw.githubusercontent.com/yakinikuningen2/walking/<SHA>/<パス>` です。履歴には削除コミット`55dbadcaa6f1c9c0edea9cb5dd97d241ebcaf2f2`も残ります。

[ちょうどいいイラストの規約](https://tyoudoii-illust.com/利用規約/)と[ICOON MONOの規約](https://icooon-mono.com/license/)は、Web・アプリへの組込み利用と、素材自体の再配布を区別しています。原本が取得できる公開履歴については、追加許諾を得るか、公開履歴・残存コピーを除去する対応が必要です。ここでは個別の違法性を確定したとは扱いません。

`.gitignore`は2ファイル名を任意フォルダで無視するように強化しました。これは新たな追加の防止であり、履歴の除去ではありません。強制追加までは防げません。

履歴を除去する場合に残る作業：

1. 作業の承認・バックアップ・共同作業者への影響を確認し、公開先のbranch／tag／PR／fork等の到達可能な参照を再調査。
2. 必要な履歴・参照を処理し、承認された範囲で更新。通常の削除コミットだけで除去済みとしない。
3. 旧SHA URLとキャッシュを再確認。履歴書換え後も残る場合、GitHub Support等に対象リポジトリ、上記SHA・パス、確認日・HTTP結果、除去済み範囲、必要なら権利者の申告情報を整理して相談。Supportが必ず削除に応じるとは保証しない。

今回、この3段階や権利者への連絡は実行していません。権利者への連絡やGit履歴の破壊的変更は別の承認・指示が必要です。

## 残る対応：外部APIの規約

| 対象 | 確認できたこと | 残る点 |
| --- | --- | --- |
| OSM標準タイル | [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)の帰属・HTTPS・Referer・キャッシュ・一括取得禁止を確認。現在は通常の対話表示で、テストのタイルは固定応答へ差替え | 多数の利用者が使う公開サービスの無制限利用・可用性は保証されない |
| Photon | [公式README](https://github.com/komoot/photon#demo-server)は合理的な利用量の範囲でプロジェクト利用を認め、過負荷の制限・停止を明記 | 端末内の制限だけで全利用者の合計負荷を保証しない |
| Valhalla／FOSSGIS | [公式README](https://github.com/valhalla/valhalla#demo-server)の識別ヘッダーと公開アプリの連絡依頼を確認。X-Client-Id・問い合わせ間隔・帰属・地図修正リンクは実装済み | 運営者がGitHub Discussionsへ連絡したかは未確認。FOSSGISの規約全文はアクセス拒否で確認できず。一般公開の許諾を取得済みとは判定しない |
| Private.coffee Overpass | [2026-04-10版の規約](https://overpass.private.coffee/)は商用を含む利用を案内。公平利用・同時要求の制限・OSM帰属・個人識別可能情報を含めない条件を確認 | 現在地等の座標が文脈次第で個人を識別し得る場合の扱いを運営者・提供元で確認する必要がある |
| overpass-api.de | [提供元の利用説明](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)の共有資源・過負荷防止・利用規模の説明を確認 | 公開アプリの規模・共有IP・リクエスト量に応じた運用が必要 |
| ORS | [現行規約](https://account.heigit.org/info/tos)のAPI結果CC BY-SA 4.0、帰属、回数・速度制限、個人データ送信禁止を動的本文で再確認 | 個別アカウントの契約・プランは未確認。現在地・経由地等の座標が個人データに該当する場合の利用条件は別途確認が必要 |
| Wikimedia API | [API利用方針](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines)の識別・制限への対応・再利用条件を確認。識別User-Agent・同時2件・間隔・429/503後の抑制・短期キャッシュを実装 | 各写真の権利の真正性と著作権以外の権利はAPIで一括保証されない |

位置座標は一律にすべて個人データだと断定するものでも、一律に該当しないと判断するものでもありません。氏名・IDを送らないこと、利用者の同意があることだけで、提供元の禁止事項が解除されるとは扱いません。確認を理由に既存機能を無断で停止・削除していません。

## 今回の修正と検証

- `place_photos.py`：ObjectNameを優先して作品名を保持。長すぎる作品名を省略せず不採用にする。
- `static/js/place-photos.js`：写真下と拡大画面に作品名を明示。
- `test_place_photos.py`：旧版CCの作品名・HTML除去・長すぎる作品名・未指定時の扱いを検証。
- `.gitignore`：元PNGを任意のフォルダで除外。
- README、THIRD_PARTY_NOTICES、アプリ内出典ページ・台帳、本報告を更新。
- `app.py`と`test_data_licenses.py`：本報告を公開文書の配信対象に追加。ソース・環境変数等の非公開ファイルを拒否する既存の配信制限は維持。

Python49件（同梱物・出典配信・写真）・JavaScript13件（写真）の計62件が成功。`.gitignore`はルート・旧フォルダ・別フォルダの同名ファイルを無視することを確認。Pythonパッケージ5件のライセンスファイルを確認しました。

Chromeの1440×900、390×844、320×568で、写真クレジットに作品名・著作者・ライセンス・出典が表示されること、拡大・条件検索・ランダム検索・登録・周遊・通常ルートが動作すること、JavaScript例外なしを確認。APIは固定応答で、新たな大量検索・タイル巡回は行っていません。

写真のPython変更を通常の実行サーバーへ反映するには再起動が必要です。本番Renderのデプロイ後・実機Safari・第三者のforkや転載の全件確認は実施していません。自動テストが成功しても、上記の未解決の許諾・運用条件を満たした証明にはなりません。
