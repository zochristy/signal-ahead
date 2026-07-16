"use client";

import { useEffect, useRef, useState } from "react";

type View = "setup" | "run";
type YMD = { y: number; m: number; d: number };

type SealedMessage = {
  id: number;
  day: number;
  text: string;
  audioUrl: string | null;
  sec: number;
  reply?: string; // 회신 자막
  replyAudio?: string | null; // 회신 음성
  replySec?: number;
};

type Channel = {
  id: number;
  goal: string;
  totalDays: number;
  daysLeft: number;
  thread: SealedMessage[];
  reached: boolean;
  start: YMD; // 개설일 (DAY 1)
  target: YMD; // 목표일
};

const MAX_MEMO_SEC = 60;
const MESH_N = 13;
const DEFAULT_DAYS = 3;

// Cohere: 근블랙(설정) · 딥 그린 다크밴드(송신 TX) · 밝은 캔버스(수신·회고 RX, 인버스)
const BG_SETUP = "#17171c";
const BG_ACCRUE = "#003c33";
const BG_REVIEW = "#eeece7"; // soft-stone 캔버스 — 송신 다크와 인버스
const CANVAS = "#ffffff";
const DARK = "#17171c"; // dark fill on light surfaces (knob inner, selected day)
const TEXT = "#ffffff";
const LIGHT = "#f7f6f3"; // near-white text / mesh dots
const MUTED = "rgba(255,255,255,0.55)";
const MUTED_L = "rgba(255,255,255,0.5)";
const FAINT = "rgba(255,255,255,0.06)"; // elevated surfaces (dark)
const HAIR = "rgba(255,255,255,0.16)"; // hairline borders (dark)
const CORAL = "#ff7759"; // single warm accent
const CORAL_SOFT = "#ffad9b";
// 밝은 회고(RX) 표면 토큰 (인버스)
const L_FG = "#17171c";
const L_SUB = "rgba(0,0,0,0.5)";
const L_SURFACE = "#ffffff";
const L_HAIR = "rgba(0,0,0,0.12)";
const L_FAINT = "rgba(0,0,0,0.04)";

const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
const toUTC = (t: YMD) => Date.UTC(t.y, t.m - 1, t.d);
const clampDay = (t: YMD): YMD => ({ ...t, d: Math.min(t.d, daysInMonth(t.y, t.m)) });
const plusDays = (t: YMD, n: number): YMD => {
  const d = new Date(t.y, t.m - 1, t.d + n);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
};
const ymdKey = (y: number, m: number, d: number) => `${y}-${m}-${d}`;

// --- Web Speech API ---
type SpeechRecognitionAlt = { transcript: string };
type SpeechRecognitionResult = { 0: SpeechRecognitionAlt; isFinal: boolean };
type SpeechRecognitionEvent = { resultIndex: number; results: { length: number; [i: number]: SpeechRecognitionResult } };
type SpeechRecognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  start: () => void; stop: () => void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
};
function getRecognitionCtor(): (new () => SpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const MESH_GRID: ({ dist: number; local: number; seed: number } | null)[] = (() => {
  const grid: ({ dist: number; local: number; seed: number } | null)[] = [];
  const mid = (MESH_N - 1) / 2;
  for (let r = 0; r < MESH_N; r++) for (let c = 0; c < MESH_N; c++) {
    const dx = (c - mid) / mid, dy = (r - mid) / mid, dist = Math.hypot(dx, dy);
    if (dist <= 1.03) grid.push({ dist, local: Math.max(0, 1 - dist), seed: Math.abs((Math.sin(r * 12.9898 + c * 4.1414) * 43758.5453) % 1) });
    else grid.push(null);
  }
  return grid;
})();

function Mesh({ level, size = "min(72vw, 260px)", color = LIGHT }: { level: number; size?: string; color?: string }) {
  const act = level;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${MESH_N}, 1fr)`, gridTemplateRows: `repeat(${MESH_N}, 1fr)`, width: size, aspectRatio: "1 / 1", placeItems: "center", transform: `scale(${1 + act * 0.16})`, transition: "transform 0.05s linear" }}>
      {MESH_GRID.map((cell, i) => {
        if (!cell) return <span key={i} />;
        const reach = act * 1.25;
        const intensity = cell.dist <= reach ? Math.max(0.28, 1 - cell.dist / (reach + 0.001)) : 0;
        const dot = 3 + intensity * 21 + cell.seed * intensity * 6;
        return <span key={i} style={{ width: dot, height: dot, borderRadius: "50%", background: color, opacity: 0.2 + intensity * 0.8, transition: "width 0.05s linear, height 0.05s linear, opacity 0.05s linear" }} />;
      })}
    </div>
  );
}

function Dial({ label, value, onUp, onDown }: { label: string; value: string; onUp: () => void; onDown: () => void }) {
  return (
    <div style={dialCol}>
      <button style={triBtn} onClick={onUp} aria-label={`${label} 증가`}>▲</button>
      <div className="mono" style={dialValue}>{value}</div>
      <div style={dialUnit}>{label}</div>
      <button style={triBtn} onClick={onDown} aria-label={`${label} 감소`}>▼</button>
    </div>
  );
}

// 채널 선택 바 — 앱 톤(다크·코랄)에 맞춘 심플한 인디케이터, 모드별 색 반전
function ChannelBar({ channels, currentId, onPrev, onNext, mode, light }: { channels: Channel[]; currentId: number; onPrev: () => void; onNext: () => void; mode: "tx" | "rx"; light?: boolean }) {
  const idx = channels.findIndex((c) => c.id === currentId);
  const multi = channels.length > 1;
  const fg = light ? L_FG : TEXT;
  const sub = light ? L_SUB : MUTED;
  const surface = light ? "rgba(0,0,0,0.05)" : "rgba(0,0,0,0.28)";
  const hair = light ? L_HAIR : HAIR;
  return (
    <div style={{ ...chanBar, background: surface, border: `1px solid ${hair}` }}>
      <button className="btn" style={{ ...chanArrow, color: fg, opacity: multi ? 0.7 : 0.2 }} onClick={onPrev} disabled={!multi} aria-label="이전 채널">‹</button>
      <div style={chanCenter}>
        <div style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
          <span className="mono" style={{ fontSize: 18, fontWeight: 600, letterSpacing: 1.5, color: fg }}>CH {pad2(currentId)}</span>
          <span className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, color: CORAL }}>{mode.toUpperCase()}</span>
        </div>
        <span className="mono" style={{ fontSize: 10, letterSpacing: 1, color: sub }}>{idx + 1} / {channels.length}</span>
      </div>
      <button className="btn" style={{ ...chanArrow, color: fg, opacity: multi ? 0.7 : 0.2 }} onClick={onNext} disabled={!multi} aria-label="다음 채널">›</button>
    </div>
  );
}

// 컴팩트 음성 재생 버튼
function VoiceButton({ src, dur, accent, label = "음성 듣기", light, compact }: { src: string; dur: number; accent: string; label?: string; light?: boolean; compact?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [d, setD] = useState(dur);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const onTime = () => setCur(a.currentTime);
    const onMeta = () => { if (isFinite(a.duration) && a.duration > 0) setD(a.duration); };
    const onEnd = () => { setPlaying(false); setCur(0); };
    a.addEventListener("timeupdate", onTime); a.addEventListener("loadedmetadata", onMeta); a.addEventListener("ended", onEnd);
    return () => { a.removeEventListener("timeupdate", onTime); a.removeEventListener("loadedmetadata", onMeta); a.removeEventListener("ended", onEnd); };
  }, [src]);
  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else a.play().then(() => setPlaying(true)).catch(() => {});
  };
  if (compact) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
        <audio ref={ref} src={src} preload="metadata" />
        <button onClick={toggle} aria-label={label} style={{ ...voiceDot, ...voiceDotBtn, background: accent }}>{playing ? "❚❚" : "▶"}</button>
        <span className="mono" style={{ fontSize: 11, color: light ? L_SUB : MUTED }}>{playing ? fmtTime(cur) : fmtTime(d)}</span>
      </span>
    );
  }
  return (
    <button onClick={toggle} style={{ ...voicePill, background: light ? L_FAINT : "rgba(255,255,255,0.10)", border: `1px solid ${light ? L_HAIR : HAIR}`, color: light ? L_FG : TEXT }}>
      <audio ref={ref} src={src} preload="metadata" />
      <span style={{ ...voiceDot, background: accent }}>{playing ? "❚❚" : "▶"}</span>
      <span className="mono" style={{ fontSize: 13 }}>{playing ? fmtTime(cur) : label} <span style={{ color: light ? L_SUB : MUTED }}>/ {fmtTime(d)}</span></span>
    </button>
  );
}

// 회고 달력: 무전 있는 날 coral 점, 탭하면 그 날 무전 선택
function MiniCalendar({ channel, selectedIdx, onSelect, calYM, onMonth }: {
  channel: Channel; selectedIdx: number; onSelect: (i: number) => void;
  calYM: { y: number; m: number }; onMonth: (dir: 1 | -1) => void;
}) {
  const marks = new Map<string, number>();
  channel.thread.forEach((m, i) => {
    const k = channel.totalDays - m.day + 1; // DAY 순번
    const d = plusDays(channel.start, k - 1);
    marks.set(ymdKey(d.y, d.m, d.d), i);
  });
  const startKey = ymdKey(channel.start.y, channel.start.m, channel.start.d);
  const targetKey = ymdKey(channel.target.y, channel.target.m, channel.target.d);
  const { y, m } = calYM;
  const firstDow = new Date(y, m - 1, 1).getDay();
  const days = daysInMonth(y, m);
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const WD = ["일", "월", "화", "수", "목", "금", "토"];

  return (
    <div style={calCard}>
      <div style={calHead}>
        <button style={calArrow} onClick={() => onMonth(-1)} aria-label="이전 달">‹</button>
        <span className="mono" style={{ fontSize: 13, letterSpacing: 1 }}>{y} · {m}월</span>
        <button style={calArrow} onClick={() => onMonth(1)} aria-label="다음 달">›</button>
      </div>
      <div style={calWeekRow}>{WD.map((w) => <span key={w} style={calWeekCell}>{w}</span>)}</div>
      <div style={calGrid}>
        {cells.map((d, i) => {
          if (d == null) return <span key={i} />;
          const key = ymdKey(y, m, d);
          const idx = marks.get(key);
          const has = idx !== undefined;
          const sel = has && idx === selectedIdx;
          const isTarget = key === targetKey;
          const isStart = key === startKey;
          return (
            <button
              key={i}
              className="btn"
              onClick={() => has && onSelect(idx!)}
              disabled={!has}
              style={{
                ...calDay,
                cursor: has ? "pointer" : "default",
                background: sel ? CORAL : "transparent",
                color: sel ? "#fff" : has ? L_FG : "rgba(0,0,0,0.28)",
                border: (isTarget || isStart) && !sel ? `1px solid ${L_HAIR}` : "1px solid transparent",
                fontWeight: has ? 600 : 400,
              }}
              aria-label={has ? `${m}월 ${d}일 무전 보기` : `${m}월 ${d}일`}
            >
              {d}
              {has && !sel && <span style={calDot} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 송신(TX) ↔ 수신(RX) 무전기 토글 스위치: 누르면 반대 모드로 슬라이드
function TxRxSwitch({ mode, onToggle, disabled, light }: { mode: "tx" | "rx"; onToggle: () => void; disabled?: boolean; light?: boolean }) {
  const rx = mode === "rx";
  const led = (on: boolean): React.CSSProperties => ({ width: 7, height: 7, borderRadius: "50%", background: on ? CORAL : (light ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.22)"), boxShadow: on ? `0 0 7px ${CORAL}` : "none", flexShrink: 0, transition: "all 0.2s ease" });
  const trackBg = light ? "rgba(0,0,0,0.06)" : "rgba(0,0,0,0.28)";
  const underColor = light ? L_FG : TEXT;
  const knobBg = light ? DARK : CANVAS;
  const knobFg = light ? "#fff" : DARK;
  return (
    <button className="btn" onClick={() => !disabled && onToggle()} disabled={disabled} style={{ ...txTrack, background: trackBg, border: `1px solid ${light ? L_HAIR : HAIR}` }} aria-label={rx ? "송신(TX) 모드로 전환" : "수신·회고(RX) 모드로 전환"}>
      <span style={{ ...txUnder, left: 0, color: underColor, opacity: rx ? 0.5 : 0 }}><span style={led(false)} /><span className="mono">TX</span></span>
      <span style={{ ...txUnder, right: 0, color: underColor, opacity: rx ? 0 : 0.5 }}><span className="mono">RX</span><span style={led(false)} /></span>
      <span style={{ ...txKnob, background: knobBg, color: knobFg, transform: rx ? "translateX(100%)" : "translateX(0)" }}>
        {rx
          ? (<><span className="mono">RX · 수신</span><span style={led(true)} /></>)
          : (<><span style={led(true)} /><span className="mono">TX · 송신</span></>)}
      </span>
    </button>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("setup");
  const [flipping, setFlipping] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentId, setCurrentId] = useState<number>(1);

  const [goal, setGoal] = useState("");
  const [today, setToday] = useState<YMD | null>(null);
  const [target, setTarget] = useState<YMD>({ y: 2026, m: 1, d: 1 });

  const [isRecording, setIsRecording] = useState(false);
  const [sec, setSec] = useState(0);
  const [level, setLevel] = useState(0);
  const [liveText, setLiveText] = useState("");
  const [justSent, setJustSent] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [calYM, setCalYM] = useState<{ y: number; m: number }>({ y: 2026, m: 1 });

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalTextRef = useRef("");
  const holdingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const levelRef = useRef(0);
  const secRef = useRef(0);
  const sentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelsRef = useRef<Channel[]>([]);
  const currentIdRef = useRef(1);
  const activeIdxRef = useRef(0);

  useEffect(() => { channelsRef.current = channels; }, [channels]);
  useEffect(() => { currentIdRef.current = currentId; }, [currentId]);
  useEffect(() => { activeIdxRef.current = activeIdx; }, [activeIdx]);

  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  useEffect(() => {
    const now = new Date();
    const t = new Date(now);
    t.setDate(t.getDate() + DEFAULT_DAYS);
    setToday({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
    setTarget({ y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() });
  }, []);

  const totalDaysToTarget = today ? Math.round((toUTC(target) - toUTC(today)) / 86400000) : 0;
  const validDate = totalDaysToTarget >= 1;

  const current = channels.find((c) => c.id === currentId) ?? null;
  const bg = view === "setup" ? BG_SETUP : current?.reached ? BG_REVIEW : BG_ACCRUE;
  const accent = CORAL;
  const progress = current && current.totalDays > 0 ? Math.round(((current.totalDays - current.daysLeft) / current.totalDays) * 100) : 0;
  const nextChNo = (channels.length ? Math.max(...channels.map((c) => c.id)) : 0) + 1;

  // 도착 시: 마지막 무전을 선택하고 달력을 그 달로 이동
  const reached = current?.reached ?? false;
  const threadLen = current?.thread.length ?? 0;

  // 송신(TX) 다크 ↔ 수신·회고(RX) 밝은 캔버스 인버스
  const lightMode = reached;
  const c = lightMode
    ? { fg: L_FG, sub: L_SUB, surface: L_SURFACE, faint: L_FAINT, hair: L_HAIR, knob: DARK, knobInner: LIGHT }
    : { fg: TEXT, sub: MUTED, surface: FAINT, faint: FAINT, hair: HAIR, knob: CANVAS, knobInner: DARK };

  // 상태바(theme-color)를 현재 밴드 색과 동기화
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", bg);
  }, [bg]);
  useEffect(() => {
    if (!current || !reached || threadLen === 0) return;
    const last = threadLen - 1;
    const k = current.totalDays - current.thread[last].day + 1;
    const d = plusDays(current.start, k - 1);
    setCalYM({ y: d.y, m: d.m });
    setActiveIdx(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, reached, threadLen]);

  function stepCalMonth(dir: 1 | -1) {
    setCalYM(({ y, m }) => {
      let mm = m + dir, yy = y;
      if (mm > 12) { mm = 1; yy++; }
      if (mm < 1) { mm = 12; yy--; }
      return { y: yy, m: mm };
    });
  }

  function tick() {
    const analyser = analyserRef.current, data = dataRef.current;
    if (!analyser || !data) return;
    analyser.getByteTimeDomainData(data as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const x = (data[i] - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / data.length);
    const targetLvl = rms < 0.006 ? 0 : Math.min(1, Math.pow(rms * 9, 0.55));
    const k = targetLvl > levelRef.current ? 0.75 : 0.22;
    levelRef.current = levelRef.current * (1 - k) + targetLvl * k;
    setLevel(levelRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }
  function stopMeter() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null; analyserRef.current = null; dataRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null; levelRef.current = 0; setLevel(0);
  }

  // 마이크 스트림을 한 번 잡아두고 재사용 (권한 팝업이 hold를 끊는 문제 회피)
  async function getMic(): Promise<MediaStream> {
    const existing = streamRef.current;
    if (existing && existing.getAudioTracks().some((t) => t.readyState === "live")) return existing;
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = s;
    return s;
  }

  async function startRecording() {
    if (isRecording) return;
    const ch = channelsRef.current.find((c) => c.id === currentIdRef.current);
    if (!ch) return;
    // 당일(최신 DAY) 무전은 회신도 잠금 — 내일 열림
    if (ch.reached) {
      const sm = ch.thread[activeIdxRef.current];
      const latest = ch.thread.length ? Math.max(...ch.thread.map((m) => ch.totalDays - m.day + 1)) : 0;
      if (sm && ch.totalDays - sm.day + 1 === latest) { setMicError("당일 무전은 내일 열려요. 회신도 그때 가능해요."); return; }
    }
    holdingRef.current = true;
    setMicError(null); setLiveText(""); setJustSent(null);
    finalTextRef.current = ""; secRef.current = 0; setSec(0);
    setIsRecording(true);

    let stream: MediaStream;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error("insecure");
      stream = await getMic();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (!window.isSecureContext || !navigator.mediaDevices)
        setMicError("HTTPS 주소에서만 마이크가 켜져요. https:// 로 접속하세요.");
      else if (name === "NotAllowedError")
        setMicError("마이크 권한이 거부됐어요. 카카오톡·인스타 등 인앱 브라우저면 Safari/Chrome로 열어주세요.");
      else if (name === "NotFoundError")
        setMicError("마이크를 찾을 수 없어요.");
      else setMicError("마이크를 시작할 수 없어요. 인앱 브라우저면 Safari/Chrome로 열어보세요.");
      setIsRecording(false);
      holdingRef.current = false;
      return;
    }
    // 권한 팝업 때문에 누르는 사이 손을 뗀 경우: 스트림은 유지(프라임)하고 이번 건 스킵
    if (!holdingRef.current) {
      setIsRecording(false);
      setJustSent("마이크 준비됨 · 다시 눌러 말하세요");
      if (sentTimerRef.current) clearTimeout(sentTimerRef.current);
      sentTimerRef.current = setTimeout(() => setJustSent(null), 2200);
      return;
    }

    chunksRef.current = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
    rec.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunksRef.current, { type: "audio/webm" }));
      autoSend(url); // 스트림은 재사용 위해 유지
    };
    rec.start();
    recorderRef.current = rec;

    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    audioCtxRef.current = audioCtx; analyserRef.current = analyser; dataRef.current = new Uint8Array(analyser.fftSize);
    rafRef.current = requestAnimationFrame(tick);

    const RecogCtor = getRecognitionCtor();
    if (RecogCtor) {
      const recog = new RecogCtor();
      recog.lang = "ko-KR"; recog.continuous = true; recog.interimResults = true;
      recog.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalTextRef.current += r[0].transcript; else interim += r[0].transcript;
        }
        setLiveText(finalTextRef.current + interim);
      };
      recog.onerror = () => {};
      recognitionRef.current = recog;
      try { recog.start(); } catch { /* 무시 */ }
    }

    timerRef.current = setInterval(() => {
      setSec((s) => { const next = s + 1; secRef.current = next; if (next >= MAX_MEMO_SEC) stopRecording(); return next; });
    }, 1000);
  }

  function stopRecording() {
    holdingRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopMeter();
    setIsRecording(false);
    setLiveText(finalTextRef.current);
  }

  // 떼면 자동 전송: 미도달=송신(새 무전) / 도달=현재 카드에 음성 회신
  function autoSend(url: string) {
    const text = finalTextRef.current.trim();
    const len = secRef.current;
    if (!text && len < 1) { URL.revokeObjectURL(url); finalTextRef.current = ""; setLiveText(""); setSec(0); return; }
    const cid = currentIdRef.current;
    const ch = channelsRef.current.find((c) => c.id === cid);
    if (!ch) { URL.revokeObjectURL(url); return; }

    if (ch.reached) {
      const idx = activeIdxRef.current;
      if (!ch.thread[idx]) { URL.revokeObjectURL(url); setLiveText(""); finalTextRef.current = ""; secRef.current = 0; setSec(0); return; }
      setChannels((prev) => prev.map((c) => c.id !== cid ? c : {
        ...c, thread: c.thread.map((m, i) => i === idx ? { ...m, reply: text, replyAudio: url, replySec: len } : m),
      }));
      setJustSent("회신 완료");
    } else {
      setChannels((prev) => prev.map((c) => c.id !== cid ? c : {
        ...c,
        thread: [...c.thread, { id: c.thread.length + 1, day: c.daysLeft, text, audioUrl: url, sec: len }],
        daysLeft: Math.max(0, c.daysLeft - 1),
      }));
      setJustSent(`DAY ${ch.totalDays - ch.daysLeft + 1} 송신 완료`);
    }
    setLiveText(""); finalTextRef.current = ""; secRef.current = 0; setSec(0);
    if (sentTimerRef.current) clearTimeout(sentTimerRef.current);
    sentTimerRef.current = setTimeout(() => setJustSent(null), 1800);
  }

  function stepYear(dir: 1 | -1) { setTarget((t) => clampDay({ ...t, y: Math.min(2100, Math.max(today?.y ?? 2020, t.y + dir)) })); }
  function stepMonth(dir: 1 | -1) { setTarget((t) => { let m = t.m + dir, y = t.y; if (m > 12) { m = 1; y++; } if (m < 1) { m = 12; y--; } return clampDay({ y, m, d: t.d }); }); }
  function stepDay(dir: 1 | -1) { setTarget((t) => { const max = daysInMonth(t.y, t.m); let d = t.d + dir; if (d < 1) d = max; if (d > max) d = 1; return { ...t, d }; }); }

  function createChannel() {
    if (!goal.trim() || !validDate) return;
    const id = channels.length ? Math.max(...channels.map((c) => c.id)) + 1 : 1;
    setChannels((prev) => [...prev, { id, goal: goal.trim(), totalDays: totalDaysToTarget, daysLeft: totalDaysToTarget, thread: [], reached: false, start: today ?? { ...target }, target: { ...target } }]);
    setCurrentId(id); setView("run"); setGoal("");
    if (today) setTarget(plusDays(today, DEFAULT_DAYS));
  }
  function newChannelForm() { setGoal(""); if (today) setTarget(plusDays(today, DEFAULT_DAYS)); setView("setup"); }

  function switchChannel(dir: 1 | -1) {
    if (channels.length < 2) return;
    const ids = channels.map((c) => c.id);
    const i = ids.indexOf(currentId);
    setCurrentId(ids[(i + dir + ids.length) % ids.length]);
    setActiveIdx(0);
  }
  // 송신(TX) ↔ 수신·회고(RX) 자유 전환 — daysLeft(카운트다운)는 유지
  function toggleMode() {
    if (isRecording || flipping) return;
    setFlipping(true);
    // 90°(엣지-온, ≈50%)에서 TX↔RX 내용 스왑 → 뒤집힌 반대 면이 드러남
    window.setTimeout(() => {
      setChannels((prev) => prev.map((c) => c.id === currentId ? { ...c, reached: !c.reached } : c));
      setActiveIdx(0);
    }, 305);
    window.setTimeout(() => setFlipping(false), 640);
  }

  const dayLabel = (ch: Channel, m: SealedMessage) => ch.totalDays - m.day + 1;

  // 당일(가장 최근에 녹음한 무전)은 회고에서 재생·회신 모두 잠금 — 내일 열림
  const latestDayLabel = current && current.thread.length ? Math.max(...current.thread.map((m) => dayLabel(current, m))) : 0;
  const activeSm = current?.reached ? current.thread[activeIdx] : undefined;
  const activeLocked = !!(activeSm && dayLabel(current!, activeSm) === latestDayLabel);

  return (
    <div style={{ ...shell, background: bg }}>
      <main style={main}>
        {/* ============ 목표 설정 ============ */}
        {view === "setup" && (
          <div style={{ ...colFill, color: LIGHT }}>
            <header>
              <h1 className="h-display" style={{ fontSize: 44, margin: 0 }}>Signal<br />Ahead</h1>
              <p style={{ fontSize: 16, color: MUTED_L, margin: "10px 0 0" }}>{channels.length ? `새 채널 CH.${pad2(nextChNo)} 개설` : "미래의 나에게 봉인 송신"}</p>
            </header>

            <div style={lcdSetupPanel}>
              <div style={lcdFieldRow}>
                <span className="mono" style={lcdSetupTag}>CH.{pad2(nextChNo)}</span>
                <input value={goal} onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); } }} enterKeyHint="done" placeholder="도달한 미래의 나를 입력" style={lcdInput} className="mono lcd-input" />
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: goal.trim() ? CORAL : "rgba(255,255,255,0.2)", flexShrink: 0 }} />
              </div>
            </div>

            <div style={lcdSetupPanel}>
              <div style={dialRowLcd}>
                <Dial label="년" value={String(target.y)} onUp={() => stepYear(1)} onDown={() => stepYear(-1)} />
                <span style={dialSepLcd}>/</span>
                <Dial label="월" value={pad2(target.m)} onUp={() => stepMonth(1)} onDown={() => stepMonth(-1)} />
                <span style={dialSepLcd}>/</span>
                <Dial label="일" value={pad2(target.d)} onUp={() => stepDay(1)} onDown={() => stepDay(-1)} />
              </div>
              <p className="mono" style={{ margin: 0, fontSize: 12, letterSpacing: 0.5, color: validDate ? MUTED_L : CORAL_SOFT, textAlign: "center", borderTop: `1px solid ${HAIR}`, paddingTop: 10 }}>
                {today == null ? " " : validDate ? `송신 기간 · ${totalDaysToTarget}일  ·  D-${totalDaysToTarget}` : "미래의 날짜를 선택하세요"}
              </p>
            </div>

            <div style={{ marginTop: "auto", display: "grid", gap: 10 }}>
              <button className="btn" onClick={createChannel} disabled={!goal.trim() || !validDate} style={{ ...primaryBtn, background: LIGHT, color: DARK }}>{channels.length ? "채널 개설 →" : "무전 시작 →"}</button>
              {channels.length > 0 && <button className="btn" onClick={() => setView("run")} style={{ ...ghostBtn, width: "100%", background: "rgba(255,255,255,0.12)", color: LIGHT }}>기존 채널로 돌아가기</button>}
            </div>
          </div>
        )}

        {/* ============ RUN ============ */}
        {view === "run" && current && (
          <div className={`no-select${flipping ? " radio-flip" : ""}`} style={{ ...colFillTight, color: c.fg }}>
            {/* 상단: 무전기 LCD 채널 디스플레이 + 새 채널 */}
            <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
              <ChannelBar channels={channels} currentId={currentId} onPrev={() => switchChannel(-1)} onNext={() => switchChannel(1)} mode={current.reached ? "rx" : "tx"} light={lightMode} />
              <button className="btn" onClick={newChannelForm} disabled={isRecording} aria-label="새 채널" style={{ ...newChBtn, background: lightMode ? "rgba(0,0,0,0.05)" : "rgba(0,0,0,0.28)", color: c.fg, border: `1px solid ${c.hair}` }}>＋</button>
            </div>

            {/* 헤더 (송신/수신 공통 구조, 색만 다름) */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: 2 }}>
              <div>
                <h1 className="h-display" style={{ fontSize: 22, margin: 0, maxWidth: 210 }}>{current.goal}</h1>
                <p style={{ fontSize: 13, color: c.sub, margin: "3px 0 0" }}>{current.reached ? "미래의 나" : "지금의 나"}</p>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="h-display" style={{ fontSize: 22, overflow: "hidden" }}><span key={current.daysLeft} className="roll-down">{current.daysLeft > 0 ? `D-${current.daysLeft}` : "도착"}</span></div>
                <div className="mono" style={{ fontSize: 12, color: c.sub }}>{current.reached ? `${current.thread.length}개 · 회고` : `${progress}% · ${current.thread.length}개`}</div>
              </div>
            </div>

            {/* 도착: 달력으로 되돌아보기 + 선택한 날 무전 상세 */}
            {current.reached ? (
              current.thread.length === 0 ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
                  <p style={{ fontSize: 14, color: c.sub }}>수신된 무전이 없어요.</p>
                </div>
              ) : (
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  <MiniCalendar channel={current} selectedIdx={activeIdx} onSelect={setActiveIdx} calYM={calYM} onMonth={stepCalMonth} />
                  {(() => {
                    const sm = current.thread[activeIdx];
                    if (!sm) return <p style={{ fontSize: 13, color: c.sub, textAlign: "center", margin: "4px 0 0" }}>날짜를 눌러 그 날의 무전을 열어보세요</p>;
                    const locked = activeLocked;
                    return (
                      <div style={{ ...detailCard, transform: isRecording ? `scale(${1 + level * 0.03})` : "scale(1)", boxShadow: isRecording ? `0 0 0 2px ${CORAL}` : "none", transition: "transform 0.05s, box-shadow 0.1s" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <div className="mono" style={{ fontSize: 12, color: CORAL, letterSpacing: 0.5 }}>DAY {dayLabel(current, sm)}의 나</div>
                          {sm.audioUrl && !locked && <VoiceButton src={sm.audioUrl} dur={sm.sec} accent={CORAL} light compact />}
                        </div>
                        <p style={preview}>{sm.text || <span style={{ color: L_SUB }}>(음성 메시지)</span>}</p>
                        <div style={{ marginTop: 8, borderTop: `1px solid ${L_HAIR}`, paddingTop: 8 }}>
                          {sm.reply || sm.replyAudio ? (
                            <>
                              <div className="mono" style={{ fontSize: 11, color: CORAL, fontWeight: 700, marginBottom: 6 }}>미래의 나 · 회신</div>
                              {sm.reply && <p style={{ fontSize: 14, margin: "0 0 8px", lineHeight: 1.4 }}>{sm.reply}</p>}
                              {sm.replyAudio && <VoiceButton src={sm.replyAudio} dur={sm.replySec ?? 0} accent={CORAL} label="회신 듣기" light compact />}
                            </>
                          ) : (
                            <p className="mono" style={{ fontSize: 12, color: L_SUB, margin: 0 }}>아래 버튼을 눌러 이 무전에 회신</p>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )
            ) : (
              /* 송신: 스피커 메시 (음성 반응) */
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
                <Mesh level={level} color={LIGHT} size="min(72vw, 260px)" />
              </div>
            )}

            {/* 타이머 + 상태 */}
            <div>
              <div style={{ textAlign: "center" }}>
                <span className="mono" style={{ fontSize: 14, color: c.sub, letterSpacing: 1 }}>
                  {pad2(Math.floor(sec / 60))}:{pad2(sec % 60)} / {pad2(Math.floor(MAX_MEMO_SEC / 60))}:{pad2(MAX_MEMO_SEC % 60)}
                </span>
              </div>
              <p style={{ fontSize: 20, lineHeight: 1.3, textAlign: "center", margin: "5px 0 0", minHeight: 26, overflow: "hidden", color: justSent || liveText || isRecording ? c.fg : c.sub, fontWeight: justSent ? 600 : 500 }}>
                <span key={justSent ? `sent:${justSent}` : "live"} className={justSent ? "roll-up" : undefined}>
                  {justSent ?? (liveText || (isRecording ? (current.reached ? "회신 녹음 중… (떼면 전송)" : "송신 중… (떼면 전송)") : current.reached ? (activeLocked ? "오늘 쓴 건 내일부터 회고할 수 있어요" : "날짜를 골라 누른 채 회신") : "버튼을 누른 채 말하세요"))}
                </span>
              </p>
            </div>

            {micError && <p style={{ fontSize: 12, color: lightMode ? "#b30000" : CORAL_SOFT, textAlign: "center", margin: 0 }}>{micError}</p>}

            {/* PUSH-TO-TALK */}
            <div style={{ display: "flex", justifyContent: "center", margin: "4px 0 8px" }}>
              <button
                onPointerDown={(e) => { if (activeLocked) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); startRecording(); }}
                onPointerUp={() => stopRecording()}
                onPointerCancel={() => stopRecording()}
                onContextMenu={(e) => e.preventDefault()}
                disabled={activeLocked}
                aria-label={activeLocked ? "당일 무전은 회신 불가" : "누른 채 회신"}
                style={{ ...talkKnob, background: c.knob, transform: isRecording ? "scale(0.94)" : "scale(1)", opacity: activeLocked ? 0.4 : 1, cursor: activeLocked ? "not-allowed" : "pointer" }}
              >
                <span style={{ width: isRecording ? 24 : 20, height: isRecording ? 24 : 20, borderRadius: isRecording ? 5 : "50%", background: isRecording ? accent : c.knobInner, transition: "all 0.15s ease" }} />
              </button>
            </div>

            {/* 하단 액션 — TX↔RX 토글 (전체 폭) */}
            <div style={{ display: "flex", alignItems: "stretch" }}>
              <TxRxSwitch mode={current.reached ? "rx" : "tx"} onToggle={toggleMode} disabled={isRecording} light={lightMode} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ---- 스타일 ----
const shell: React.CSSProperties = { height: "100dvh", display: "flex", justifyContent: "center", overflow: "hidden", transition: "background 0.4s ease" };
// perspective는 flip 대상(RUN div)의 '바로 위 부모'인 main에 걸어야 3D가 먹는다.
// (shell에 걸면 중간 main이 3D 컨텍스트를 평평하게 눌러 perspective가 안 닿음)
const main: React.CSSProperties = { width: "100%", maxWidth: 420, height: "100%", padding: "16px 20px calc(16px + env(safe-area-inset-bottom))", display: "flex", flexDirection: "column", boxSizing: "border-box", perspective: 900, perspectiveOrigin: "50% 45%" };
const colFill: React.CSSProperties = { flex: 1, display: "flex", flexDirection: "column", gap: 16, minHeight: 0, overflowY: "auto" };
const colFillTight: React.CSSProperties = { flex: 1, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 };


// Cohere pill CTA — white on dark bands
const primaryBtn: React.CSSProperties = { background: LIGHT, color: DARK, border: "none", borderRadius: 32, padding: "16px 24px", fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em", width: "100%", cursor: "pointer" };
const ghostBtn: React.CSSProperties = { background: FAINT, color: TEXT, border: `1px solid ${HAIR}`, borderRadius: 32, padding: "15px 18px", fontSize: 15, fontWeight: 500, cursor: "pointer" };

// 채널 선택 바 (심플)
const chanBar: React.CSSProperties = { display: "flex", alignItems: "center", flex: 1, minWidth: 0, borderRadius: 12, overflow: "hidden", padding: "0 4px" };
const chanArrow: React.CSSProperties = { width: 34, height: 42, border: "none", background: "transparent", fontSize: 22, cursor: "pointer", lineHeight: 1, flexShrink: 0 };
const chanCenter: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, padding: "6px 4px" };
const newChBtn: React.CSSProperties = { width: 48, flexShrink: 0, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 400, cursor: "pointer", lineHeight: 1 };


const dialRowLcd: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "4px 4px 12px" };
const dialCol: React.CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: 1 };
const dialValue: React.CSSProperties = { fontSize: 30, fontWeight: 500, letterSpacing: 1, lineHeight: 1, color: TEXT };
const dialUnit: React.CSSProperties = { fontSize: 11, color: MUTED_L, fontWeight: 500 };
const dialSepLcd: React.CSSProperties = { fontSize: 22, color: "rgba(255,255,255,0.28)", fontWeight: 300, marginTop: -14 };
const triBtn: React.CSSProperties = { border: "none", background: "transparent", color: TEXT, opacity: 0.55, fontSize: 13, cursor: "pointer", padding: 4, lineHeight: 1 };

// 설정 패널 (목표·날짜) — 앱 톤에 맞춘 심플한 다크 카드
const lcdSetupPanel: React.CSSProperties = { background: "rgba(0,0,0,0.22)", border: `1px solid ${HAIR}`, borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 };
const lcdSetupTag: React.CSSProperties = { fontSize: 12, fontWeight: 600, letterSpacing: 1, color: CORAL, flexShrink: 0 };
const lcdFieldRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const lcdInput: React.CSSProperties = { flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: TEXT, fontSize: 18, letterSpacing: 0.3 };

const talkKnob: React.CSSProperties = { width: 74, height: 74, borderRadius: "50%", border: "none", background: CANVAS, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", touchAction: "none", userSelect: "none", transition: "transform 0.1s ease", boxShadow: "0 6px 20px rgba(0,0,0,0.35)" };

// 회고 달력 (밝은 캔버스 · 인버스)
const calCard: React.CSSProperties = { background: L_SURFACE, border: `1px solid ${L_HAIR}`, borderRadius: 16, padding: "9px 11px", flexShrink: 0, color: L_FG };
const calHead: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 };
const calArrow: React.CSSProperties = { width: 32, height: 26, border: "none", background: "transparent", color: L_FG, fontSize: 20, cursor: "pointer", lineHeight: 1 };
const calWeekRow: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 2 };
const calWeekCell: React.CSSProperties = { textAlign: "center", fontSize: 10, color: L_SUB, padding: "1px 0" };
const calGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 };
const calDay: React.CSSProperties = { position: "relative", height: 26, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, fontSize: 13, background: "transparent", padding: 0 };
const calDot: React.CSSProperties = { position: "absolute", bottom: 3, left: "50%", transform: "translateX(-50%)", width: 4, height: 4, borderRadius: "50%", background: CORAL };

const detailCard: React.CSSProperties = { background: L_SURFACE, border: `1px solid ${L_HAIR}`, borderRadius: 14, padding: 12, color: L_FG };
const preview: React.CSSProperties = { fontSize: 14, lineHeight: 1.45, margin: "8px 0 0", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" };

// TX→RX 무전기 스위치
const txTrack: React.CSSProperties = { position: "relative", flex: 1, height: 48, borderRadius: 28, background: "rgba(0,0,0,0.28)", border: `1px solid ${HAIR}`, cursor: "pointer", overflow: "hidden", padding: 0, display: "block" };
const txUnder: React.CSSProperties = { position: "absolute", top: 0, bottom: 0, width: "50%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13, letterSpacing: 1, color: TEXT, transition: "opacity 0.3s ease" };
const txKnob: React.CSSProperties = { position: "absolute", top: 3, bottom: 3, left: 3, width: "calc(50% - 3px)", borderRadius: 24, background: CANVAS, color: DARK, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13, fontWeight: 500, letterSpacing: 0.5, transition: "transform 0.36s cubic-bezier(0.5, 0, 0.2, 1)", boxShadow: "0 3px 12px rgba(0,0,0,0.4)" };

const voicePill: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 10, background: "rgba(255,255,255,0.10)", border: `1px solid ${HAIR}`, borderRadius: 9999, padding: "8px 14px 8px 8px", cursor: "pointer", color: TEXT };
const voiceDot: React.CSSProperties = { width: 26, height: 26, borderRadius: "50%", color: "#fff", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
const voiceDotBtn: React.CSSProperties = { width: 24, height: 24, border: "none", padding: 0, cursor: "pointer" };
