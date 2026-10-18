import { addPropertyControls, ControlType, RenderTarget } from "framer"
import { useEffect, useId, useState, type ReactNode } from "react"

const API="https://dhnmqgxjxwlfsmoaogvh.supabase.co/functions/v1/model-dashboard"
const PLACES=[["library","Library"],["cafe","Cafe"],["home","Home"],["dorm_room","Dorm room"],["classroom","Classroom"]] as const
// API coefficients use rating units. Match the backend missing-feature encoding.
export function placeEstimate(snapshot:any,place:string,target:"productivity"|"mood"):number|null{
    if(!PLACES.some(p=>p[0]===place)||!(snapshot?.model?.totalObservations??snapshot?.model?.observations))return null
    const active=["bias",...(place==="home"?[]:["location:"+place]),"missing:study_space","missing:clutter","missing:lighting","missing:ergonomics","missing:duration"]
    let score=3
    for(const feature of active){const value=snapshot.model.weights.find((w:any)=>w.feature===feature)?.[target];if(!Number.isFinite(value))return null;score+=value}
    return Math.min(5,Math.max(1,score))
}

const FRAME_DESKTOP = { width: 1107, height: 905 }
const FRAME_MOBILE = { width: 351, height: 905 }
const MOBILE_BREAKPOINT = 600

function getFrameForViewport() {
    if (typeof window === "undefined") return FRAME_DESKTOP
    return window.innerWidth <= MOBILE_BREAKPOINT ? FRAME_MOBILE : FRAME_DESKTOP
}

function useFrameSize() {
    const [size, setSize] = useState(getFrameForViewport)

    useEffect(() => {
        const update = () => {
            setSize(
                window.innerWidth <= MOBILE_BREAKPOINT
                    ? FRAME_MOBILE
                    : FRAME_DESKTOP
            )
        }
        update()
        window.addEventListener("resize", update)
        return () => window.removeEventListener("resize", update)
    }, [])

    return size
}

const FONT = "'Anton', sans-serif"
const BLUE = "#0054B5"
const BLUE_MID = "#3378C4"
const BLACK = "#0D0D0D"
const WHITE = "#FFFFFF"

const BUBBLE_LEFT =
    "M 22 2 H 378 Q 398 2 398 22 V 148 Q 398 168 378 168 H 72 L 6 186 L 26 168 H 22 Q 2 168 2 148 V 22 Q 2 2 22 2 Z"

const BUBBLE_LEFT_COMPACT =
    "M 20 2 H 380 Q 398 2 398 20 V 96 Q 398 114 380 114 H 68 L 8 132 L 24 114 H 20 Q 2 114 2 96 V 20 Q 2 2 20 2 Z"

const BUBBLE_RIGHT =
    "M 22 2 H 378 Q 398 2 398 22 V 148 Q 398 168 378 168 H 328 L 394 186 L 374 168 H 22 Q 2 168 2 148 V 22 Q 2 2 22 2 Z"

const BUBBLE_RIGHT_COMPACT =
    "M 20 2 H 380 Q 398 2 398 20 V 96 Q 398 114 380 114 H 332 L 392 132 L 376 114 H 20 Q 2 114 2 96 V 20 Q 2 2 20 2 Z"

/** Same width for every chat bubble */
const BUBBLE_WIDTH = "78%"
const EDGE_INSET = 10

function clamp(n: number, min: number, max: number) {
    return Math.min(max, Math.max(min, n))
}

type RowProps = {
    side: "left" | "right"
    variant: "blue" | "white"
    compact?: boolean
    hovered: boolean
    onEnter: () => void
    onLeave: () => void
    children: ReactNode
}

function MessageRow({
    side,
    variant,
    compact = false,
    hovered,
    onEnter,
    onLeave,
    children,
}: RowProps) {
    const isRight = side === "right"
    const isBlue = variant === "blue"
    const scale = hovered ? 1.02 : 1
    const gradId = useId().replace(/:/g, "")
    const useCompactShape = compact
    const path = isRight
        ? useCompactShape
            ? BUBBLE_RIGHT_COMPACT
            : BUBBLE_RIGHT
        : compact
          ? BUBBLE_LEFT_COMPACT
          : BUBBLE_LEFT
    const viewBox = useCompactShape ? "0 0 400 132" : "0 0 400 190"
    const minH = compact ? 132 : 180
    const pad = compact ? "20px 26px 32px" : "28px 32px 44px"
    const bubbleWidth = compact ? BUBBLE_WIDTH : "62%"

    return (
        <div
            style={{
                width: "100%",
                flex: "0 0 auto",
                display: "flex",
                justifyContent: isRight ? "flex-end" : "flex-start",
                alignItems: "flex-start",
                paddingTop: 6,
                paddingBottom: 20,
                paddingLeft: isRight ? 0 : EDGE_INSET,
                paddingRight: isRight ? EDGE_INSET : 0,
                boxSizing: "border-box",
            }}
        >
            <div
                onMouseEnter={onEnter}
                onMouseLeave={onLeave}
                onTouchStart={onEnter}
                onTouchEnd={onLeave}
                style={{
                    position: "relative",
                    width: bubbleWidth,
                    minHeight: minH,
                    transform: `scale(${scale})`,
                    transformOrigin: isRight ? "100% 50%" : "0% 50%",
                    transition: "transform 0.2s ease, filter 0.2s ease",
                    filter: hovered
                        ? isBlue
                            ? "drop-shadow(0 12px 28px rgba(0, 84, 181, 0.32))"
                            : "drop-shadow(0 10px 24px rgba(0, 0, 0, 0.1))"
                        : isBlue
                          ? "drop-shadow(0 8px 22px rgba(0, 84, 181, 0.22))"
                          : "drop-shadow(0 6px 18px rgba(0, 0, 0, 0.07))",
                }}
            >
                <svg
                    viewBox={viewBox}
                    preserveAspectRatio="none"
                    aria-hidden
                    style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        display: "block",
                    }}
                >
                    {isBlue ? (
                        <defs>
                            <linearGradient
                                id={gradId}
                                x1="0%"
                                y1="0%"
                                x2="100%"
                                y2="100%"
                            >
                                <stop offset="0%" stopColor={BLUE_MID} />
                                <stop offset="100%" stopColor={BLUE} />
                            </linearGradient>
                        </defs>
                    ) : null}
                    <path
                        d={path}
                        fill={isBlue ? `url(#${gradId})` : WHITE}
                        stroke={isBlue ? BLUE : "none"}
                        strokeWidth={isBlue ? 2.5 : 0}
                        strokeLinejoin="round"
                    />
                </svg>
                <div
                    style={{
                        position: "relative",
                        zIndex: 1,
                        padding: pad,
                        boxSizing: "border-box",
                        minHeight: minH,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        color: isBlue ? WHITE : BLACK,
                        fontFamily: FONT,
                    }}
                >
                    {children}
                </div>
            </div>
        </div>
    )
}

function MetricBubbleContent({
    label,
    value,
}: {
    label: string
    value: number | null
}) {
    return (
        <>
            <div
                style={{
                    fontSize: 14,
                    letterSpacing: "0.07em",
                    textTransform: "uppercase",
                    color: BLACK,
                    marginBottom: 4,
                    lineHeight: 1.2,
                }}
            >
                {label}
            </div>
            <div
                style={{
                    fontSize: 12,
                    letterSpacing: "0.04em",
                    color: BLACK,
                    opacity: 0.65,
                    marginBottom: 8,
                    lineHeight: 1.2,
                }}
            >
                1 = low · 5 = high
            </div>
            <div
                style={{
                    fontSize: 40,
                    lineHeight: 1,
                    color: BLACK,
                    letterSpacing: "0.02em",
                }}
            >
                {value === null ? "—" : value.toFixed(1) + "/5"}
            </div>
        </>
    )
}

type Props = {
    stackOrder: number
    location: string
    productivity: number
    mood: number
    distractions: number
}

export default function DailyFocusDashboardTablet(props: Props) {
    const {stackOrder = 100} = props
    const frame = useFrameSize()
    const isMobile = frame.width === FRAME_MOBILE.width
    const [hovered, setHovered] = useState<number | null>(null)
    const [place,setPlace] = useState("library")
    const [snapshot,setSnapshot] = useState<any>(null)
    const [status,setStatus] = useState("Connect your private dashboard to see your scores.")
    const canvas = RenderTarget.current() === RenderTarget.canvas
    useEffect(()=>{
        if(canvas) return
        let stopped=false, pending=false
        let controller:AbortController|null=null
        async function refresh(){
            if(stopped||pending||document.visibilityState==="hidden") return
            let token=""
            try {token=sessionStorage.getItem("study-dashboard:"+API)??""} catch {}
            if(!token){setSnapshot(null);setStatus("Connect your private dashboard to see your scores.");return}
            pending=true;controller=new AbortController()
            const timer=setTimeout(()=>controller?.abort(),12000)
            try{
                const r=await fetch(API,{headers:{Authorization:"Bearer "+token},cache:"no-store",signal:controller.signal})
                if(stopped)return
                if(r.status===401){setSnapshot(null);setStatus("Your code expired. Reconnect on Dashboard.");return}
                if(!r.ok)throw Error()
                const next=await r.json()
                if(!Array.isArray(next?.model?.weights)||!Array.isArray(next?.history))throw Error()
                setSnapshot(next);setStatus("Live model estimates · other workspace details unknown")
            }catch{if(!stopped){setSnapshot(null);setStatus("Scores temporarily unavailable. Retrying…")}}
            finally{clearTimeout(timer);pending=false}
        }
        void refresh()
        const interval=setInterval(()=>void refresh(),10000)
        const visible=()=>void refresh()
        document.addEventListener("visibilitychange",visible)
        window.addEventListener("focus",visible)
        return ()=>{stopped=true;clearInterval(interval);controller?.abort();document.removeEventListener("visibilitychange",visible);window.removeEventListener("focus",visible)}
    },[canvas])
    const p = placeEstimate(snapshot,place,"productivity")
    const m = placeEstimate(snapshot,place,"mood")
    const recorded = (snapshot?.history??[]).filter((h:any)=>h.place===place&&Number.isFinite(h.distraction)&&h.distraction>=1&&h.distraction<=5)
    const d = recorded.length ? recorded.reduce((sum:number,h:any)=>sum+h.distraction,0)/recorded.length : null

    const metrics = [
        {
            key: "productivity",
            label: "Productivity estimate",
            value: p,
            hover: 1,
        },
        { key: "mood", label: "Mood estimate", value: m, hover: 2 },
        { key: "distractions", label: "Recent distractions", value: d, hover: 3 },
    ] as const

    return (
        <div
            style={{
                position: "relative",
                width: "100%",
                height: frame.height,
                boxSizing: "border-box",
                background: "transparent",
                fontFamily: FONT,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-start",
                overflow: "visible",
                padding: "12px 0 16px",
                zIndex: stackOrder,
                isolation: "isolate",
                transform: "translateZ(0)",
            }}
        >
            <link
                href="https://fonts.googleapis.com/css2?family=Anton&display=swap"
                rel="stylesheet"
            />

            <MessageRow
                side="right"
                variant="blue"
                compact
                hovered={hovered === 0}
                onEnter={() => setHovered(0)}
                onLeave={() => setHovered(null)}
            >
                <div
                    style={{
                        fontSize: 12,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        opacity: 0.9,
                        marginBottom: 6,
                    }}
                >
                    Study place:
                </div>
                <div
                    style={{
                        fontSize: isMobile ? 32 : 44,
                        lineHeight: 1.05,
                        textTransform: "uppercase",
                        letterSpacing: "0.03em",
                    }}
                >
                    <select aria-label="Study place" value={place} onChange={e=>setPlace(e.target.value)} style={{font:"inherit",color:"inherit",background:"transparent",border:"none",borderBottom:"1px solid #ffffff80",width:"100%",cursor:"pointer",textTransform:"uppercase"}}>
                        {PLACES.map(([value,label])=><option key={value} value={value} style={{color:BLACK,background:WHITE}}>{label}</option>)}
                    </select>
                    <div style={{fontFamily:"sans-serif",fontSize:11,lineHeight:1.4,textTransform:"none",letterSpacing:0,marginTop:8}}>{status}<br/>{snapshot ? (recorded.length ? "Distraction average: "+recorded.length+" recent check-in(s)." : "No recent distraction ratings for this place.") : <a href="/dashboard" style={{color:WHITE}}>Connect on Dashboard ↗</a>}</div>
                </div>
            </MessageRow>

            <div
                style={{
                    flex: "1 1 auto",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-start",
                    gap: isMobile ? 8 : 4,
                    minHeight: 0,
                    overflow: "visible",
                }}
            >
                {metrics.map(({ key, label, value, hover }) => (
                    <MessageRow
                        key={key}
                        side="left"
                        variant="white"
                        compact
                        hovered={hovered === hover}
                        onEnter={() => setHovered(hover)}
                        onLeave={() => setHovered(null)}
                    >
                        <MetricBubbleContent label={label} value={value} />
                    </MessageRow>
                ))}
            </div>
        </div>
    )
}

addPropertyControls(DailyFocusDashboardTablet,{stackOrder:{type:ControlType.Number,title:"Stack order",defaultValue:100,min:0,max:999,step:1}})
