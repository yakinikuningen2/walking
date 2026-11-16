# Valhalla Discussions 投稿案

投稿先：[Valhalla GitHub Discussions](https://github.com/valhalla/valhalla/discussions)

運営者が自分のアカウントで投稿するための案です。投稿はしていません。下記はローカルで実装・検証した更新版を説明します。本番への反映前に投稿する場合は「preparing」の記述を残してください。公開URLのhealthは2026-11-16にHTTP200を確認しましたが、更新版をデプロイ済みという意味ではありません。実際の利用状況・問い合わせ先を確認してから投稿してください。

**Title:** Public walking web app notification and fair-use question — walking-ctsh.onrender.com

---

Hello Valhalla/FOSSGIS team,

I maintain a Japanese walking web app under the name **yakinikuningen**:

- Public URL: https://walking-ctsh.onrender.com/
- Source: https://github.com/yakinikuningen2/walking
- GitHub contact: https://github.com/yakinikuningen2

Your README asks developers of public end-user apps to notify you through GitHub Discussions and identify requests. I am preparing a routing update and would like to describe our use and ask whether it is appropriate for the public demo service. The controls below are implemented and tested locally; this update is awaiting review and deployment.

The app uses `https://valhalla1.openstreetmap.de` for:

- `POST /route` with pedestrian costing for destination routes, user-requested alternatives, optional detours, multi-stop walking courses, and road distances for destination candidates;
- `POST /locate` to verify pedestrian-accessible intermediate road positions for occasional long-distance route recovery;
- `POST /height` for small batches of candidate elevations, up to 24 points.

The browser sends these requests to our own fixed-endpoint Python relay. The relay sends:

```text
X-Client-Id: walking-ctsh.onrender.com
User-Agent: WalkingMap/1.0 (+https://walking-ctsh.onrender.com/; https://github.com/yakinikuningen2/walking)
```

The relay accepts only those three actions and pedestrian routing; it does not accept arbitrary upstream URLs. There is no browser-direct retry that could bypass its limits. We are using one application instance with one Python process, shared by all users, with these application-side budgets:

- at most one upstream request in flight;
- at least one second between upstream request starts;
- at most 45 upstream request starts in a rolling minute and 1,000 in a rolling 24 hours;
- at most two waiting requests, with a two-second wait bound;
- shared cooldown on upstream 429 responses, honoring `Retry-After` with a minimum 60-second pause; temporary server failures also cause a pause;
- successful-result caching for up to five minutes, bounded to 64 results and 16 MiB, plus coalescing identical concurrent requests.

These controls are in memory and reset when the process restarts; they are not distributed quotas. Before running multiple processes or instances, I would need a shared limiter or a separate agreed service arrangement. These budgets are our own conservative caps, not a claim that the demo service has approved this volume. I do not yet have reliable user/traffic measurements to quote.

We also limit work in the client:

- no route queries simply to open or pan/zoom the map;
- automatic candidate road-distance lookups are limited to eight per page load, only for visible candidates; further lookups require an explicit click;
- in-page duplicate requests share cached results; hidden cards and obsolete searches are cancelled;
- location-based route refreshes require usable, confirmed location fixes and meaningful progress (normally 50 m) or off-route deviation, with at least 20 seconds between automatic refreshes;
- automatic route refreshes stop when the page is hidden and do not regenerate unrelated route types;
- multi-stop generation is user initiated and bounded to 14 routing calls and 45 seconds per course-generation operation;
- long-route recovery is bounded to 16 fetched segments, a small number of locate batches, 120 seconds for segmentation, and 150 seconds for the overall client operation. We validate walking access and continuity and never draw invented straight-line connectors.

Actual start/end/intermediate coordinates and pedestrian options are sent; the server rounds location coordinates to six decimal places, which is not an anonymity guarantee. We do not send a user's name, device identifier, private visit notes, or browser IP as additional upstream fields. We do not upload a continuous GPS track. Our app displays OpenStreetMap attribution, a map-correction link, and links to source/licence information and its privacy policy. We do not perform routing for bulk data extraction or offline downloads.

Could you confirm whether this intended public use, including the server relay and occasional long pedestrian routes with locate/elevation requests, fits the demo service's fair-use expectations? Please let me know if you would prefer tighter limits, additional identification, or a separate/self-hosted service. I will not treat this notification or the presence of a client header as permission to exceed your policies.

Thank you for maintaining Valhalla and the public service.

yakinikuningen
