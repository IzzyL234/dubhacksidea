import * as React from "react"
import { addPropertyControls, ControlType, RenderTarget } from "framer"
type Snapshot = {
    updatedAt: string
    dataAsOf: string | null
    model: {
        algorithm: string
        observations: number
        excluded: number
        status: string
        weights: { feature: string; productivity: number; mood: number }[]
    }
    prediction: null | {
        label: string
        recordedAt: string
        productivity: number
        mood: number
        uncertainty: number
    }
    history: {
        date: string
        productivity: number
        mood: number
        distraction: number
        place: string
    }[]
    events: { at: string; action: string; reason: string; count: number }[]
}
type Props = {
    apiUrl: string
    accent: string
    textColor: string
    surface: string
    style?: React.CSSProperties
}
const human = (s: string) => s.replaceAll("_", " ").replaceAll(":", ": ")
const when = (s: string | null) =>
    s
        ? new Date(s).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
          })
        : "No synced activity yet"
function endpoint(value: string): string | null {
    try {
        const u = new URL(value)
        return u.protocol === "https:" &&
            u.hostname.endsWith(".supabase.co") &&
            !u.username &&
            !u.password &&
            /^\/functions\/v1\/model-dashboard\/?$/.test(u.pathname) &&
            !u.search &&
            !u.hash
            ? u.toString().replace(/\/$/, "")
            : null
    } catch {
        return null
    }
}
/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export default function LearningPanel({
    apiUrl = "",
    accent = "#718268",
    textColor = "#20251e",
    surface = "#ffffff",
    style,
}: Props) {
    const canvas = RenderTarget.current() === RenderTarget.canvas,
        url = endpoint(apiUrl),
        storageKey = "study-dashboard:" + url
    const [token, setToken] = React.useState(""),
        [code, setCode] = React.useState(""),
        [data, setData] = React.useState<Snapshot | null>(null),
        [error, setError] = React.useState(""),
        [busy, setBusy] = React.useState(false),
        [connected, setConnected] = React.useState(false)
    React.useEffect(() => {
        setData(null)
        setConnected(false)
        setError("")
        setToken("")
        if (canvas || !url) return
        try {
            setToken(sessionStorage.getItem(storageKey) ?? "")
        } catch {}
    }, [url, canvas])
    React.useEffect(() => {
        if (canvas || !url || !token) return
        let ended = false,
            inFlight = false,
            controller: AbortController | null = null
        async function refresh() {
            if (ended || inFlight || document.visibilityState === "hidden")
                return
            inFlight = true
            controller = new AbortController()
            const timer = setTimeout(() => controller?.abort(), 12000)
            setBusy(true)
            try {
                const response = await fetch(url!, {
                    headers: { Authorization: "Bearer " + token },
                    cache: "no-store",
                    signal: controller.signal,
                })
                if (ended) return
                if (response.status === 401) {
                    try {
                        sessionStorage.removeItem(storageKey)
                    } catch {}
                    setToken("")
                    setData(null)
                    setConnected(false)
                    setError(
                        "Code expired or disconnected. Text dashboard code to your bot for a new one."
                    )
                    return
                }
                if (!response.ok)
                    throw Error(
                        response.status === 403
                            ? "This Framer site's origin still needs to be allowed in the backend settings."
                            : "Connection interrupted. Retrying automatically; displayed values are from the last successful update."
                    )
                const next = (await response.json()) as Snapshot
                if (
                    !next?.model ||
                    !Number.isFinite(next.model.observations) ||
                    !Array.isArray(next.history) ||
                    !Array.isArray(next.events)
                )
                    throw Error(
                        "The dashboard returned an unexpected response."
                    )
                if (ended) return
                setData(next)
                setError("")
                setConnected(true)
                try {
                    sessionStorage.setItem(storageKey, token)
                } catch {}
            } catch (e) {
                if (!ended) {
                    setConnected(false)
                    setError(
                        e instanceof Error && e.name !== "AbortError"
                            ? e.message
                            : "Connection timed out. Retrying automatically."
                    )
                }
            } finally {
                clearTimeout(timer)
                inFlight = false
                if (!ended) setBusy(false)
            }
        }
        void refresh()
        const interval = setInterval(() => void refresh(), 10000),
            visible = () => {
                if (document.visibilityState === "visible") void refresh()
            }
        document.addEventListener("visibilitychange", visible)
        return () => {
            ended = true
            controller?.abort()
            clearInterval(interval)
            document.removeEventListener("visibilitychange", visible)
        }
    }, [token, url, canvas])
    const card: React.CSSProperties = {
            border: "1px solid #deded6",
            borderRadius: 16,
            padding: 18,
            background: surface,
        },
        muted: React.CSSProperties = {
            opacity: 0.65,
            fontSize: 13,
            lineHeight: 1.5,
        },
        button: React.CSSProperties = {
            border: 0,
            borderRadius: 10,
            padding: "12px 16px",
            background: accent,
            color: "#fff",
            font: "inherit",
            cursor: "pointer",
        }
    const prediction = data?.prediction
    const disconnect = () => {
        try {
            sessionStorage.removeItem(storageKey)
        } catch {}
        setToken("")
        setCode("")
        setData(null)
        setError("")
        setConnected(false)
    }
    const weights = [...(data?.model.weights ?? [])]
        .filter((w) => w.feature !== "bias")
        .sort(
            (a, b) =>
                Math.abs(b.productivity) +
                Math.abs(b.mood) -
                Math.abs(a.productivity) -
                Math.abs(a.mood)
        )
        .slice(0, 6)
    return (
        <section
            style={{
                ...style,
                width: "100%",
                height: "auto",
                boxSizing: "border-box",
                color: textColor,
                fontFamily: "inherit",
                padding: 24,
                background: surface,
                borderRadius: 22,
                lineHeight: 1.45,
            }}
            aria-label="Your learning dashboard"
        >
            <div
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 16,
                    alignItems: "start",
                    flexWrap: "wrap",
                }}
            >
                <div>
                    <div
                        style={{
                            ...muted,
                            textTransform: "uppercase",
                            letterSpacing: ".12em",
                            fontSize: 11,
                        }}
                    >
                        Your study assistant
                    </div>
                    <h2
                        style={{
                            margin: "6px 0 8px",
                            fontSize: 30,
                            fontWeight: 550,
                            letterSpacing: "-.04em",
                        }}
                    >
                        Your learning, unfolding.
                    </h2>
                    <p style={{ ...muted, margin: 0 }}>
                        Real sessions. Your feedback. A clearer picture of what
                        works for you.
                    </p>
                </div>
                {token && (
                    <button
                        style={{
                            ...button,
                            background: "transparent",
                            color: textColor,
                            border: "1px solid #ddd",
                            fontSize: 12,
                        }}
                        onClick={disconnect}
                    >
                        Disconnect this browser
                    </button>
                )}
            </div>
            {canvas || !token ? (
                <div style={{ ...card, marginTop: 24 }}>
                    <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>
                        Connect your study history
                    </h3>
                    <p style={muted}>
                        Text <strong>dashboard code</strong> to your bot, then
                        paste the private code here. It grants read-only access
                        to your chat's learning data for 24 hours.
                    </p>
                    {!url && (
                        <p style={muted}>
                            Add the hosted model-dashboard API URL in this
                            component's Framer settings.
                        </p>
                    )}
                    <form
                        onSubmit={(e) => {
                            e.preventDefault()
                            if (
                                !canvas &&
                                url &&
                                /^[A-Za-z0-9_-]{43}$/.test(code.trim())
                            ) {
                                setError("")
                                setToken(code.trim())
                                setCode("")
                            }
                        }}
                        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                    >
                        <input
                            aria-label="Private dashboard code"
                            placeholder="Paste dashboard code"
                            type="password"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            autoComplete="off"
                            style={{
                                flex: "1 1 200px",
                                minWidth: 0,
                                border: "1px solid #ddd",
                                borderRadius: 10,
                                padding: 12,
                                font: "inherit",
                                color: textColor,
                                background: surface,
                            }}
                        />
                        <button
                            type="submit"
                            disabled={
                                canvas ||
                                !url ||
                                !/^[A-Za-z0-9_-]{43}$/.test(code.trim())
                            }
                            style={{
                                ...button,
                                opacity:
                                    canvas || !url || code.trim().length !== 43
                                        ? 0.5
                                        : 1,
                            }}
                        >
                            Connect
                        </button>
                    </form>
                    <p style={{ ...muted, fontSize: 11 }}>
                        Text disconnect dashboard to revoke access on every
                        browser.
                    </p>
                </div>
            ) : (
                <>
                    <p
                        role="status"
                        aria-live="polite"
                        style={{ ...muted, margin: "20px 0 12px" }}
                    >
                        {connected
                            ? "● Connected to your saved history"
                            : busy
                              ? "Connecting…"
                              : "○ Reconnecting"}
                        {data ? " · Updated " + when(data.updatedAt) : ""}
                    </p>
                    {data && (
                        <>
                            <div
                                style={{
                                    display: "grid",
                                    gridTemplateColumns:
                                        "repeat(auto-fit,minmax(150px,1fr))",
                                    gap: 12,
                                }}
                            >
                                {[
                                    [
                                        "Sessions learned from",
                                        String(data.model.observations),
                                    ],
                                    [
                                        "Productivity estimate",
                                        prediction
                                            ? prediction.productivity.toFixed(
                                                  1
                                              ) + " / 5"
                                            : "—",
                                    ],
                                    [
                                        "Mood estimate",
                                        prediction
                                            ? prediction.mood.toFixed(1) +
                                              " / 5"
                                            : "—",
                                    ],
                                ].map(([label, value]) => (
                                    <div key={label} style={card}>
                                        <div style={muted}>{label}</div>
                                        <div
                                            style={{
                                                fontSize: 32,
                                                marginTop: 8,
                                            }}
                                        >
                                            {value}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <p style={{ ...muted, fontSize: 12 }}>
                                {prediction
                                    ? prediction.label +
                                      " · " +
                                      when(prediction.recordedAt) +
                                      ". Estimates are associations, not guarantees."
                                    : "Complete a linked study session with workspace details and ratings to start personalizing these estimates."}
                            </p>
                            <div style={{ ...card, marginTop: 18 }}>
                                <h3 style={{ fontSize: 17, margin: "0 0 8px" }}>
                                    Your recent sessions
                                </h3>
                                {data.history.length ? (
                                    <>
                                        {data.history.length > 1 && (
                                            <svg
                                                viewBox="0 0 600 120"
                                                role="img"
                                                aria-label="Productivity and mood ratings across recent sessions"
                                                style={{
                                                    width: "100%",
                                                    height: 120,
                                                    overflow: "visible",
                                                }}
                                            >
                                                {[1, 3, 5].map((n) => (
                                                    <g key={n}>
                                                        <line
                                                            x1="24"
                                                            x2="580"
                                                            y1={
                                                                110 -
                                                                (n - 1) * 25
                                                            }
                                                            y2={
                                                                110 -
                                                                (n - 1) * 25
                                                            }
                                                            stroke="currentColor"
                                                            opacity=".08"
                                                        />
                                                        <text
                                                            x="2"
                                                            y={
                                                                114 -
                                                                (n - 1) * 25
                                                            }
                                                            fontSize="10"
                                                            fill="currentColor"
                                                        >
                                                            {n}
                                                        </text>
                                                    </g>
                                                ))}
                                                {(
                                                    [
                                                        "productivity",
                                                        "mood",
                                                    ] as const
                                                ).map((k, i) => (
                                                    <polyline
                                                        key={k}
                                                        fill="none"
                                                        stroke={
                                                            i
                                                                ? textColor
                                                                : accent
                                                        }
                                                        strokeWidth="2.5"
                                                        strokeDasharray={
                                                            i
                                                                ? "5 5"
                                                                : undefined
                                                        }
                                                        points={[
                                                            ...data.history,
                                                        ]
                                                            .reverse()
                                                            .map((h, j, a) =>
                                                                [
                                                                    24 +
                                                                        (j *
                                                                            556) /
                                                                            (a.length -
                                                                                1),
                                                                    110 -
                                                                        (h[k] -
                                                                            1) *
                                                                            25,
                                                                ].join(",")
                                                            )
                                                            .join(" ")}
                                                    />
                                                ))}
                                            </svg>
                                        )}
                                        <div style={{ ...muted, fontSize: 11 }}>
                                            Solid: productivity · Dashed: mood ·
                                            Recorded ratings, 1–5
                                        </div>
                                        {data.history
                                            .slice(0, 5)
                                            .map((h, i) => (
                                                <div
                                                    key={h.date + i}
                                                    style={{
                                                        display: "flex",
                                                        justifyContent:
                                                            "space-between",
                                                        gap: 12,
                                                        padding: "10px 0",
                                                        borderTop:
                                                            "1px solid #eee",
                                                        fontSize: 13,
                                                    }}
                                                >
                                                    <span>
                                                        {human(h.place)} ·{" "}
                                                        {when(h.date)}
                                                    </span>
                                                    <span>
                                                        Focus {h.productivity}/5
                                                        · Mood {h.mood}/5
                                                    </span>
                                                </div>
                                            ))}
                                    </>
                                ) : (
                                    <p style={muted}>
                                        Your first completed check-in will
                                        appear here.
                                    </p>
                                )}
                            </div>
                            <div style={{ ...card, marginTop: 18 }}>
                                <h3 style={{ fontSize: 17, margin: "0 0 8px" }}>
                                    What the agent decided
                                </h3>
                                {data.events.length ? (
                                    data.events.slice(0, 6).map((e, i) => (
                                        <div
                                            key={e.at + i}
                                            style={{
                                                padding: "10px 0",
                                                borderTop: i
                                                    ? "1px solid #eee"
                                                    : undefined,
                                                fontSize: 13,
                                            }}
                                        >
                                            <div>
                                                {human(e.action)} ·{" "}
                                                {human(e.reason)}
                                            </div>
                                            <div
                                                style={{
                                                    ...muted,
                                                    fontSize: 11,
                                                }}
                                            >
                                                {when(e.at)} · {e.count} checks
                                            </div>
                                        </div>
                                    ))
                                ) : (
                                    <p style={muted}>
                                        Decisions will appear after the running
                                        bot saves an update.
                                    </p>
                                )}
                            </div>
                            <details style={{ ...card, marginTop: 18 }}>
                                <summary
                                    style={{ cursor: "pointer", fontSize: 14 }}
                                >
                                    Inside the model
                                </summary>
                                <p style={muted}>
                                    {data.model.algorithm} ·{" "}
                                    {data.model.observations} real observations.
                                </p>
                                {weights.map((w) => (
                                    <div
                                        key={w.feature}
                                        style={{
                                            display: "grid",
                                            gridTemplateColumns:
                                                "1fr 90px 90px",
                                            gap: 8,
                                            padding: "6px 0",
                                            fontSize: 12,
                                        }}
                                    >
                                        <span>{human(w.feature)}</span>
                                        <span>
                                            Focus {w.productivity.toFixed(2)}
                                        </span>
                                        <span>Mood {w.mood.toFixed(2)}</span>
                                    </div>
                                ))}
                                <p style={{ ...muted, fontSize: 11 }}>
                                    Signed coefficients for normalized inputs;
                                    not causal effects or importance
                                    percentages.
                                    {prediction
                                        ? " Model uncertainty: " +
                                          prediction.uncertainty.toFixed(2) +
                                          " (not a probability)."
                                        : ""}
                                </p>
                            </details>
                            <p style={{ ...muted, fontSize: 11 }}>
                                Refreshes every 10 seconds while visible. Bot
                                syncs about once a minute. Latest saved
                                activity: {when(data.dataAsOf)}.
                            </p>
                        </>
                    )}
                </>
            )}
            {error && (
                <p
                    role="alert"
                    style={{ fontSize: 13, color: "#a34b35", marginTop: 14 }}
                >
                    {error}
                </p>
            )}
        </section>
    )
}
addPropertyControls(LearningPanel, {
    apiUrl: {
        type: ControlType.String,
        title: "API URL",
        placeholder: "https://project.supabase.co/functions/v1/model-dashboard",
    },
    accent: {
        type: ControlType.Color,
        title: "Accent",
        defaultValue: "#718268",
    },
    textColor: {
        type: ControlType.Color,
        title: "Text",
        defaultValue: "#20251e",
    },
    surface: {
        type: ControlType.Color,
        title: "Surface",
        defaultValue: "#ffffff",
    },
})
