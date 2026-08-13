import { useCallback, useContext, useEffect, useState } from "react";
import "./App.css";
import { connect as gattConnect } from "@zmkfirmware/zmk-studio-ts-client/transport/gatt";
import {
  ZMKConnection,
  ZMKAppContext,
  useStudioLockState,
  isUnlockRequiredError,
  isWebSerialSupported,
  isWebBluetoothSupported,
  useCustomSubsystem,
  connectSerial,
} from "@cormoran/zmk-studio-react-hook";
import {
  Request,
  Response,
} from "./proto/nat-chan/runtime-accel/runtime_accel";
import { CurveSvg } from "./CurveEditor";
import {
  type CurvePoint,
  toPairs,
  toInterleaved,
  FACTOR_MIN,
  FACTOR_MAX,
  MAX_POINTS,
} from "./curve";

export const SUBSYSTEM_IDENTIFIER = "nat_chan__runtime_accel";

// Template placeholder: `scripts/init_module.py` rewrites this literal to
// `{owner}/{repo}`. Never write the full
// `...-with-custom-studio-rpc` repo name in a URL built from this constant --
// the replacement targets this exact string first, which would otherwise
// leave the owner unreplaced.
export const GITHUB_REPO = "nat-chan/zmk-module-runtime-accel";

// Unlike GITHUB_REPO above, this always credits the original template
// project, regardless of which repo this module was forked into. The
// trailing comment is scripts/init_module.py's IGNORE_MARKER: it keeps this
// line from being rewritten (like GITHUB_REPO is) or flagged as a leftover
// placeholder once initialized.
export const TEMPLATE_CREDIT_REPO = "cormoran/zmk-module-template"; // zmk-module-template:keep

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>🖱️ zmk-module-runtime-accel</h1>
        <p>Runtime pointer/scroll acceleration curve editor</p>
      </header>

      <ZMKConnection
        autoReconnect
        renderDisconnected={({ connect, isLoading, error }) => (
          <section className="card">
            <h2>Device Connection</h2>
            {isLoading && <p>⏳ Connecting...</p>}
            {error && (
              <div className="error-message">
                <p>🚨 {error}</p>
              </div>
            )}
            {!isLoading && (
              <>
                <div className="connect-buttons">
                  {isWebSerialSupported() && (
                    <button
                      className="btn btn-primary"
                      onClick={() => connect(connectSerial)}
                    >
                      🔌 Connect USB
                    </button>
                  )}
                  {isWebBluetoothSupported() && (
                    <button
                      className="btn btn-primary"
                      onClick={() => connect(gattConnect)}
                    >
                      📶 Connect Bluetooth
                    </button>
                  )}
                  {!isWebSerialSupported() && !isWebBluetoothSupported() && (
                    <div className="warning-message">
                      <p>
                        ⚠️ Web Serial and Web Bluetooth are unavailable here.
                        Use a Chromium-based browser (Chrome, Edge, ...) over
                        HTTPS or localhost to connect to your keyboard.
                      </p>
                    </div>
                  )}
                </div>
                {isWebBluetoothSupported() && (
                  <p className="hint-message">
                    📶 Not showing up? Some firmware only advertises the Studio
                    Bluetooth service once unlocked — press the unlock key (
                    <code>&amp;studio_unlock</code> behavior) on your keyboard,
                    then try connecting again.
                  </p>
                )}
              </>
            )}
          </section>
        )}
        renderConnected={({ disconnect, deviceName }) => (
          <>
            <section className="card">
              <h2>Device Connection</h2>
              <div className="device-info">
                <h3>✅ Connected to: {deviceName}</h3>
              </div>
              <button className="btn btn-secondary" onClick={disconnect}>
                Disconnect
              </button>
            </section>

            <CurveEditorSection />
          </>
        )}
      />

      <footer className="app-footer">
        <p>
          <strong>zmk-module-runtime-accel</strong> - runtime-editable
          speed-to-factor acceleration curves for ZMK pointing devices
        </p>
        <p>
          <a
            href={`https://github.com/${GITHUB_REPO}`}
            target="_blank"
            rel="noreferrer"
          >
            {GITHUB_REPO}
          </a>
        </p>
        <p className="template-credit">
          Built from{" "}
          <a
            href={`https://github.com/${TEMPLATE_CREDIT_REPO}`}
            target="_blank"
            rel="noreferrer"
          >
            {TEMPLATE_CREDIT_REPO}
          </a>{" "}
          - AI ready ZMK module template by{" "}
          <a
            href="https://github.com/cormoran"
            target="_blank"
            rel="noreferrer"
          >
            @cormoran
          </a>
        </p>
      </footer>
    </div>
  );
}

export function CurveEditorSection() {
  const zmkApp = useContext(ZMKAppContext);
  const { ready, subsystem, call } = useCustomSubsystem(SUBSYSTEM_IDENTIFIER, {
    encode: (r: Request) => Request.encode(r).finish(),
    decode: Response.decode,
  });
  const { locked } = useStudioLockState();
  const [instances, setInstances] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pairs, setPairs] = useState<CurvePoint[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [awaitingUnlock, setAwaitingUnlock] = useState(false);

  const runCall = useCallback(
    async (request: Request): Promise<Response | null> => {
      if (!ready) return null;
      try {
        const resp = await call(request);
        setAwaitingUnlock(false);
        if (resp?.error) {
          setStatus(`Error: ${resp.error.message}`);
          return null;
        }
        return resp ?? null;
      } catch (error) {
        if (isUnlockRequiredError(error)) {
          setAwaitingUnlock(true);
        } else {
          console.error("RPC call failed:", error);
          setStatus(
            `Failed: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
        return null;
      }
    },
    [ready, call]
  );

  const loadCurve = useCallback(
    async (instanceId: string) => {
      const resp = await runCall({ getCurve: { instanceId } });
      if (resp?.curve) {
        setPairs(toPairs(resp.curve.points));
      }
    },
    [runCall]
  );

  const loadInstances = useCallback(async () => {
    const resp = await runCall({ listInstances: {} });
    if (resp?.instances) {
      setInstances(resp.instances.ids);
      const first = resp.instances.ids[0];
      if (first) {
        setSelected((prev) => prev ?? first);
        await loadCurve(first);
      }
    }
  }, [runCall, loadCurve]);

  useEffect(() => {
    if (ready && instances === null) {
      // Mirrors an external system (the firmware's instance list) rather
      // than deriving from props/state, so the async setState inside
      // loadInstances is intentional -- see react-hooks/set-state-in-effect's
      // rationale (same pattern as useStudioLockState itself).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadInstances();
    }
  }, [ready, instances, loadInstances]);

  // Auto-retry once the device reports it's unlocked again (same pattern as
  // the template's original sample section).
  useEffect(() => {
    if (awaitingUnlock && !locked) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAwaitingUnlock(false);
      void loadInstances();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  if (!zmkApp) return null;

  if (!subsystem) {
    return (
      <section className="card">
        <div className="warning-message">
          <p>
            ⚠️ Subsystem "{SUBSYSTEM_IDENTIFIER}" not found. Make sure your
            firmware includes the runtime-accel module. See the{" "}
            <a href={`https://github.com/${GITHUB_REPO}#readme`}>
              module README
            </a>{" "}
            for firmware setup.
          </p>
        </div>
      </section>
    );
  }

  const selectInstance = async (id: string) => {
    setSelected(id);
    setStatus(null);
    await loadCurve(id);
  };

  const setCurve = async (persist: boolean) => {
    if (!selected) return;
    setIsBusy(true);
    setStatus(null);
    try {
      const resp = await runCall({
        setCurve: {
          instanceId: selected,
          points: toInterleaved(pairs),
          persist,
        },
      });
      if (resp?.ack) {
        setStatus(persist ? "Saved to flash" : "Applied (RAM only)");
        // Reload: the firmware sanitizes (clamps/sorts) on apply.
        await loadCurve(selected);
      }
    } finally {
      setIsBusy(false);
    }
  };

  const updatePoint = (index: number, patch: Partial<CurvePoint>) => {
    setPairs((prev) =>
      prev.map((p, i) => (i === index ? { ...p, ...patch } : p))
    );
  };

  const addPoint = () => {
    setPairs((prev) => {
      if (prev.length >= MAX_POINTS) return prev;
      const last = prev[prev.length - 1];
      const next: CurvePoint = last
        ? { speed: last.speed + 500, factor: last.factor }
        : { speed: 0, factor: 1000 };
      return [...prev, next];
    });
  };

  const removePoint = (index: number) => {
    setPairs((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== index) : prev
    );
  };

  return (
    <section className="card">
      <h2>Acceleration Curves</h2>

      {locked && (
        <div className="locked-banner">
          <p>🔒 ZMK Studio is locked.</p>
        </div>
      )}

      {instances === null && <p>⏳ Loading instances...</p>}
      {instances !== null && instances.length === 0 && (
        <div className="warning-message">
          <p>
            ⚠️ No runtime-accel instances in this firmware. Add
            <code> zmk,input-processor-runtime-accel </code>
            nodes to your devicetree (see the README).
          </p>
        </div>
      )}

      {instances !== null && instances.length > 0 && (
        <>
          <div className="instance-buttons" role="group" aria-label="Instance">
            {instances.map((id) => (
              <button
                key={id}
                className={`btn ${selected === id ? "btn-primary" : "btn-secondary"}`}
                aria-pressed={selected === id}
                onClick={() => void selectInstance(id)}
              >
                {id}
              </button>
            ))}
          </div>

          <CurveSvg pairs={pairs} onChange={setPairs} />

          <div className="point-list">
            {pairs.map((p, i) => (
              <div className="point-row" key={i}>
                <label>
                  speed
                  <input
                    type="number"
                    min={0}
                    aria-label={`point ${i} speed`}
                    value={p.speed}
                    onChange={(e) =>
                      updatePoint(i, { speed: parseInt(e.target.value) || 0 })
                    }
                  />
                </label>
                <label>
                  factor
                  <input
                    type="number"
                    min={FACTOR_MIN}
                    max={FACTOR_MAX}
                    aria-label={`point ${i} factor`}
                    value={p.factor}
                    onChange={(e) =>
                      updatePoint(i, { factor: parseInt(e.target.value) || 0 })
                    }
                  />
                </label>
                <button
                  className="btn btn-secondary"
                  aria-label={`remove point ${i}`}
                  disabled={pairs.length <= 1}
                  onClick={() => removePoint(i)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="curve-actions">
            <button
              className="btn btn-secondary"
              disabled={pairs.length >= MAX_POINTS}
              onClick={addPoint}
            >
              ➕ Add Point
            </button>
            <button
              className="btn btn-primary"
              disabled={isBusy || locked || pairs.length === 0}
              onClick={() => void setCurve(false)}
            >
              {isBusy ? "⏳ ..." : "Apply (RAM)"}
            </button>
            <button
              className="btn btn-primary"
              disabled={isBusy || locked || pairs.length === 0}
              onClick={() => void setCurve(true)}
            >
              💾 Save
            </button>
          </div>

          <p className="hint-message">
            factor is permille: 1000 = 1.0x. Speed is counts/sec. The firmware
            clamps factors to {FACTOR_MIN}..{FACTOR_MAX} and sorts points by
            speed on apply.
          </p>
        </>
      )}

      {awaitingUnlock && (
        <div className="unlock-prompt card">
          <p>
            🔒 ZMK Studio is locked. Press the unlock key (
            <code>&amp;studio_unlock</code> behavior) on your keyboard — the
            request will retry automatically.
          </p>
          <button
            className="btn btn-secondary"
            onClick={() => void loadInstances()}
          >
            Retry
          </button>
        </div>
      )}

      {status && (
        <div className="response-box" data-testid="status">
          <pre>{status}</pre>
        </div>
      )}
    </section>
  );
}

export default App;
