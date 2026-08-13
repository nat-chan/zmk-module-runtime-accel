# DESIGN: zmk-module-runtime-accel

Webブラウザから実行時に編集できる「速度→倍率カーブ」型のポインタ/スクロール
アクセラレーション入力プロセッサ。torabo-tsuki-lp (BMP Boost) での利用が第一目標。

## 1. Scope

- **Feature モジュール**(input processor + custom settings + custom Studio RPC)。
  ドライバ/シールドは含まない。
- 対象イベント: `INPUT_EV_REL` の `REL_X`/`REL_Y`(zip_xy_to_scroll_mapper の
  前段に置けばスクロールにも同じ仕組みが効く)。
- Out of scope: temp-layer、軸反転・回転(既存 zip_* / cormoran
  runtime-input-processor の守備範囲)、per-layer カーブ切替(将来拡張)。

## 2. カーブモデル

- 制御点列 `(speed_cps, factor_permille)` を最大 **8点**、区間線形補間。
- `speed_cps`: counts/sec(参考実装と同じ per-event 速度推定
  `|value|*1000/dt_ms`、dt は 100ms でクランプ)。
- `factor_permille`: 1000 = 1.0x。範囲 100..20000 にクランプ。
- 補間: 先頭点より低速は先頭 factor、最終点より高速は最終 factor。
- 端数は per-axis remainder に蓄積(track-remainders 相当、常時有効)。
- 方向反転時に factor>1000 なら 1000 に抑制(参考実装踏襲)。

## 3. Config surface

- **Devicetree**: `zmk,input-processor-runtime-accel`
  - `#input-processor-cells = <0>`
  - `instance-id`(string, 必須): 設定キーの名前空間。例 `"pointer"` / `"scroll"`
  - `input-type`(int, default INPUT_EV_REL)
  - `default-curve`(array, 必須): `[s0 f0 s1 f1 ...]` 形式のデフォルトカーブ
- **Kconfig**:
  - `CONFIG_ZMK_RUNTIME_ACCEL`(本体)
  - `CONFIG_ZMK_RUNTIME_ACCEL_STUDIO_RPC`(depends on `ZMK_STUDIO` のみ。
    ハードなしでもビルド可、native_sim テスト用に 0 devices スタブあり)
- **Custom settings**(persistence): インスタンスごとに 1 エントリ
  - key: `"<instance-id>_curve"`, type: INT32 **array**(interleaved
    `[s0,f0,s1,f1,...]`、最大16要素=64B)→ 1設定で書き込みがアトミック
  - default: DTの `default-curve`と同値をハンドラ側でフォールバック
  - confidentiality: `RPC_PUBLIC`, permission: read/write とも `UNSECURE`
  - RANGE constraint は使わない(コンパイル不可 pitfall)。クランプは適用時にCで行う

## 4. State & persistence

- RAM: インスタンスごとに `struct curve { uint8_t count; int32_t pts[16]; }`
  + spinlock。イベント処理はこのRAMコピーだけを読む。
- 適用パス:
  1. **boot**: `settings_load()` は changed イベントを出さない(pitfall)→
     遅延 work(workqueue)で custom_settings から読み、無ければ DT デフォルト。
  2. **post-boot**: `zmk_custom_setting_changed` リスナーで該当キーなら再適用。
     generic settings UI 経由の書き込みでも自動で効く。
- 適用時に必ず: 要素数を偶数・2〜16 にクランプ、speed 昇順ソート、factor
  クランプ。壊れた値でもクラッシュしない。

## 5. RPC API(custom subsystem `nat_chan__runtime_accel`)

| Request | fields | Response | 想定サイズ |
|---|---|---|---|
| `ListInstances{}` | - | `Instances{ids: repeated string(max2,16B)}` | ~40B |
| `GetCurve{instance_id}` | ≤16B | `Curve{instance_id, points: repeated int32 (max16)}` | ~100B |
| `SetCurve{instance_id, points, persist:bool}` | ~110B | `Ack{}` | ~10B |

- SetCurve は custom_settings への write(`PERSIST` or `MEMORY`)に委譲し、
  changed イベント経由で適用される(適用経路を一本化)。
- バッファ: TX は Curve 応答(最悪 ~110B)+マージン → **`CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=192` 必須**、
  RX は SetCurve ~120B → **`RX_BUF_SIZE=192`**。ハンドラ隣に `BUILD_ASSERT`。
- 全て UNSECURED(カーブは機微情報でない)。

## 6. Web UI(Phase 2, dya-studio 側)

- 本リポジトリ `web/` はテンプレの開発用UI(E2Eテスト兼リファレンス)として
  カーブエディタの最小実装を持つ: インスタンス選択+SVG折れ線グラフ
  (制御点ドラッグ、追加/削除)+Save(persist)/Apply(memory)。
- dya-studio への統合はフォーク側(nat-chan/dya-studio)に Acceleration タブ
  として移植する。RPC は上表の3つのみ。

## 7. Testing

- `tests/studio/`(native_sim): デバイス0個スタブで ListInstances→空、
  DTつきオーバレイで GetCurve/SetCurve 往復、クランプ検証。
- `tests/zmk-config/`: build.yaml に RPC 有効/無効の2アーティファクト。
- Renode/web-e2e: テンプレの既存枠に GetCurve/SetCurve ケースを追加。
- 実機検証(Phase 3): torabo-tsuki-lp の pointer/scroll 2インスタンス。

## 8. Phase plan

- A: テンプレ初期化(完了)+ DESIGN.md(本書)
- B: settings + processor 本体 + RPC(proto→firmware、スライス毎にテスト)
- C: web/ の最小カーブエディタ + e2e
- D: torabo-tsuki 組込み(west.yml + overlay で zip_* 置換)と実機検証
