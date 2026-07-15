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
};

const MAX_MEMO_SEC = 60;
const MESH_N = 13;
const DEFAULT_DAYS = 3;

const BG_SETUP = "#2b2b2b";
const BG_ACCRUE = "#cf5b41";
const BG_REVIEW = "#4f8a54";
const INK = "#1d1d1f";
const MUTED = "rgba(0,0,0,0.42)";
const LIGHT = "#f2f0ea";
const MUTED_L = "rgba(255,255,255,0.5)";

const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
const toUTC = (t: YMD) => Date.UTC(t.y, t.m - 1, t.d);
const clampDay = (t: YMD): YMD => ({ ...t, d: Math.min(t.d, daysInMonth(t.y, t.m)) });
const plusDays = (t: YMD, n: number): YMD => {
  const d = new Date(t.y, t.m - 1, t.d + n);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
};

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

function Mesh({ level, size = "min(72vw, 260px)" }: { level: number; size?: string }) {
  const act = level;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${MESH_N}, 1fr)`, gridTemplateRows: `repeat(${MESH_N}, 1fr)`, width: size, aspectRatio: "1 / 1", placeItems: "center", transform: `scale(${1 + act * 0.16})`, transition: "transform 0.05s linear" }}>
      {MESH_GRID.map((cell, i) => {
        if (!cell) return <span key={i} />;
        const reach = act * 1.25;
        const intensity = cell.dist <= reach ? Math.max(0.28, 1 - cell.dist / (reach + 0.001)) : 0;
        const dot = 3 + intensity * 21 + cell.seed * intensity * 6;
        return <span key={i} style={{ width: dot, height: dot, borderRadius: "50%", background: INK, opacity: 0.2 + intensity * 0.8, transition: "width 0.05s linear, height 0.05s linear, opacity 0.05s linear" }} />;
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

function ChannelBar({ channels, currentId, onPrev, onNext }: { channels: Channel[]; currentId: number; onPrev: () => void; onNext: () => void }) {
  const idx = channels.findIndex((c) => c.id === currentId);
  const multi = channels.length > 1;
  return (
    <div style={chBar}>
      <button style={{ ...chArrow, opacity: multi ? 1 : 0.25 }} onClick={onPrev} disabled={!multi} aria-label="이전 채널">‹</button>
      <span className="mono" style={{ fontSize: 15, fontWeight: 600, letterSpacing: 1 }}>CH.{pad2(currentId)} <span style={{ color: MUTED }}>· {idx + 1}/{channels.length}</span></span>
      <button style={{ ...chArrow, opacity: multi ? 1 : 0.25 }} onClick={onNext} disabled={!multi} aria-label="다음 채널">›</button>
    </div>
  );
}

// 컴팩트 음성 재생 버튼
function VoiceButton({ src, dur, accent, label = "음성 듣기" }: { src: string; dur: number; accent: string; label?: string }) {
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
  return (
    <button onClick={toggle} style={voicePill}>
      <audio ref={ref} src={src} preload="metadata" />
      <span style={{ ...voiceDot, background: accent }}>{playing ? "❚❚" : "▶"}</span>
      <span className="mono" style={{ fontSize: 13 }}>{playing ? fmtTime(cur) : label} <span style={{ color: MUTED }}>/ {fmtTime(d)}</span></span>
    </button>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("setup");
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

  const carouselRef = useRef<HTMLDivElement>(null);
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
  const accent = current?.reached ? BG_REVIEW : BG_ACCRUE;
  const progress = current && current.totalDays > 0 ? Math.round(((current.totalDays - current.daysLeft) / current.totalDays) * 100) : 0;
  const nextChNo = (channels.length ? Math.max(...channels.map((c) => c.id)) : 0) + 1;

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

  function onCarouselScroll() {
    const el = carouselRef.current;
    if (!el) return;
    const center = el.scrollLeft + el.clientWidth / 2;
    let best = 0, bestD = Infinity;
    Array.from(el.children).forEach((ch, i) => {
      const node = ch as HTMLElement;
      const c = node.offsetLeft + node.offsetWidth / 2;
      const dd = Math.abs(c - center);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    setActiveIdx(best);
  }

  function stepYear(dir: 1 | -1) { setTarget((t) => clampDay({ ...t, y: Math.min(2100, Math.max(today?.y ?? 2020, t.y + dir)) })); }
  function stepMonth(dir: 1 | -1) { setTarget((t) => { let m = t.m + dir, y = t.y; if (m > 12) { m = 1; y++; } if (m < 1) { m = 12; y--; } return clampDay({ y, m, d: t.d }); }); }
  function stepDay(dir: 1 | -1) { setTarget((t) => { const max = daysInMonth(t.y, t.m); let d = t.d + dir; if (d < 1) d = max; if (d > max) d = 1; return { ...t, d }; }); }

  function createChannel() {
    if (!goal.trim() || !validDate) return;
    const id = channels.length ? Math.max(...channels.map((c) => c.id)) + 1 : 1;
    setChannels((prev) => [...prev, { id, goal: goal.trim(), totalDays: totalDaysToTarget, daysLeft: totalDaysToTarget, thread: [], reached: false }]);
    setCurrentId(id); setView("run"); setGoal("");
    if (today) setTarget(plusDays(today, DEFAULT_DAYS));
  }
  function newChannelForm() { setGoal(""); if (today) setTarget(plusDays(today, DEFAULT_DAYS)); setView("setup"); }
  function continueRun() { const un = channels.find((c) => !c.reached); if (un) { setCurrentId(un.id); setView("run"); } else newChannelForm(); }

  function switchChannel(dir: 1 | -1) {
    if (channels.length < 2) return;
    const ids = channels.map((c) => c.id);
    const i = ids.indexOf(currentId);
    setCurrentId(ids[(i + dir + ids.length) % ids.length]);
    setActiveIdx(0);
    if (carouselRef.current) carouselRef.current.scrollLeft = 0;
  }
  function reachTarget() { setChannels((prev) => prev.map((c) => c.id === currentId ? { ...c, reached: true, daysLeft: 0 } : c)); setActiveIdx(0); }

  const dayLabel = (ch: Channel, m: SealedMessage) => ch.totalDays - m.day + 1;

  return (
    <div style={{ ...shell, background: bg }}>
      <main style={main}>
        {/* ============ 목표 설정 ============ */}
        {view === "setup" && (
          <div style={{ ...colFill, color: LIGHT }}>
            <header>
              <h1 className="h-display" style={{ fontSize: 44, margin: 0 }}>시간<br />무전</h1>
              <p style={{ fontSize: 16, color: MUTED_L, margin: "10px 0 0" }}>{channels.length ? `새 채널 CH.${pad2(nextChNo)} 개설` : "미래의 나에게 봉인 송신"}</p>
            </header>

            <div style={{ display: "grid", gap: 10 }}>
              <span style={{ ...eyebrow, color: MUTED_L }}>CHANNEL — 목표</span>
              <div style={{ ...channelDisplay, border: "1px solid rgba(255,255,255,0.14)" }}>
                <span className="mono" style={chTag}>CH.{pad2(nextChNo)}</span>
                <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="도달한 미래의 나를 입력" style={channelInput} className="mono" />
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: goal.trim() ? "#7dd87d" : "rgba(255,255,255,0.25)", flexShrink: 0 }} />
              </div>
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              <span style={{ ...eyebrow, color: MUTED_L }}>TARGET DATE — 목표 날짜</span>
              <div style={dialRowDark}>
                <Dial label="년" value={String(target.y)} onUp={() => stepYear(1)} onDown={() => stepYear(-1)} />
                <span style={dialSepDark}>/</span>
                <Dial label="월" value={pad2(target.m)} onUp={() => stepMonth(1)} onDown={() => stepMonth(-1)} />
                <span style={dialSepDark}>/</span>
                <Dial label="일" value={pad2(target.d)} onUp={() => stepDay(1)} onDown={() => stepDay(-1)} />
              </div>
              <p style={{ margin: 0, fontSize: 13, color: validDate ? MUTED_L : "#f0a08f", textAlign: "center" }}>
                {today == null ? " " : validDate ? `봉인 기간 · ${totalDaysToTarget}일 (D-${totalDaysToTarget})` : "미래의 날짜를 선택하세요"}
              </p>
            </div>

            <div style={{ marginTop: "auto", display: "grid", gap: 10 }}>
              <button className="btn" onClick={createChannel} disabled={!goal.trim() || !validDate} style={{ ...primaryBtn, background: LIGHT, color: INK }}>{channels.length ? "채널 개설 →" : "무전 시작 →"}</button>
              {channels.length > 0 && <button className="btn" onClick={() => setView("run")} style={{ ...ghostBtn, width: "100%", background: "rgba(255,255,255,0.12)", color: LIGHT }}>기존 채널로 돌아가기</button>}
            </div>
          </div>
        )}

        {/* ============ RUN ============ */}
        {view === "run" && current && (
          <div style={colFillTight}>
            <ChannelBar channels={channels} currentId={currentId} onPrev={() => switchChannel(-1)} onNext={() => switchChannel(1)} />

            {/* 헤더 (송신/수신 공통 구조, 색만 다름) */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h1 className="h-display" style={{ fontSize: 28, margin: 0 }}>{current.reached ? "미래의 나" : "지금의 나"}</h1>
                <p style={{ fontSize: 14, color: MUTED, margin: "5px 0 0", maxWidth: 210 }}>{current.goal}</p>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="h-display" style={{ fontSize: 26 }}>{current.reached ? "도착" : `D-${current.daysLeft}`}</div>
                <div className="mono" style={{ fontSize: 12, color: MUTED }}>{current.reached ? `${current.thread.length}개` : `${progress}% · ${current.thread.length}개`}</div>
              </div>
            </div>

            {/* 도달 시: 이전 무전 카드 스트립 (가로 스와이프) */}
            {current.reached && current.thread.length > 0 && (
              <>
                <div ref={carouselRef} onScroll={onCarouselScroll} style={carouselStrip}>
                  {current.thread.map((m, i) => {
                    const isActive = i === activeIdx;
                    return (
                      <div key={m.id} style={{ ...snapCard, opacity: isActive ? 1 : 0.72, transform: isActive && isRecording ? `scale(${1 + level * 0.05})` : "scale(1)", boxShadow: isActive && isRecording ? `0 0 0 3px rgba(0,0,0,0.35)` : "none", transition: "box-shadow 0.1s, transform 0.05s, opacity 0.2s" }}>
                        <div className="mono" style={{ fontSize: 12, color: MUTED }}>DAY {dayLabel(current, m)}의 나 {isActive && <span style={{ color: accent, fontWeight: 700 }}>· 선택됨</span>}</div>
                        <p style={{ fontSize: 18, lineHeight: 1.5, fontWeight: 500, margin: "10px 0 0" }}>{m.text || <span style={{ color: MUTED }}>(음성 메시지)</span>}</p>
                        {m.audioUrl && <div style={{ marginTop: 12 }}><VoiceButton src={m.audioUrl} dur={m.sec} accent={INK} /></div>}
                        <div style={{ marginTop: "auto", paddingTop: 12 }}>
                          {m.reply || m.replyAudio ? (
                            <div style={{ borderTop: "1px solid rgba(0,0,0,0.18)", paddingTop: 10 }}>
                              <div className="mono" style={{ fontSize: 11, color: accent, fontWeight: 700, marginBottom: 6 }}>미래의 나 · 회신</div>
                              {m.reply && <p style={{ fontSize: 14, margin: "0 0 8px", lineHeight: 1.4 }}>{m.reply}</p>}
                              {m.replyAudio && <VoiceButton src={m.replyAudio} dur={m.replySec ?? 0} accent={accent} label="회신 듣기" />}
                            </div>
                          ) : (
                            <p className="mono" style={{ fontSize: 12, color: MUTED, margin: 0 }}>{isActive ? "아래 버튼을 누른 채 회신하세요" : "스와이프해 이 무전을 선택"}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={dotsRow}>
                  {current.thread.map((_, i) => <span key={i} style={{ height: 6, borderRadius: 3, transition: "all 0.2s", width: i === activeIdx ? 18 : 6, background: i === activeIdx ? INK : "rgba(0,0,0,0.22)" }} />)}
                </div>
              </>
            )}

            {/* 스피커 메시 (음성 반응) — 송신·수신 공통, 수신은 작게 */}
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
              {current.reached && current.thread.length === 0
                ? <p style={{ fontSize: 14, color: MUTED }}>수신된 무전이 없어요.</p>
                : <Mesh level={level} size={current.reached ? "min(42vw, 150px)" : "min(72vw, 260px)"} />}
            </div>

            {/* 타이머 + 상태 */}
            <div>
              <div style={{ textAlign: "center" }}>
                <span className="mono" style={{ fontSize: 14, color: MUTED, letterSpacing: 1 }}>
                  {pad2(Math.floor(sec / 60))}:{pad2(sec % 60)} / {pad2(Math.floor(MAX_MEMO_SEC / 60))}:{pad2(MAX_MEMO_SEC % 60)}
                </span>
              </div>
              <p style={{ fontSize: 17, lineHeight: 1.4, textAlign: "center", margin: "8px 0 0", minHeight: 24, color: justSent || liveText || isRecording ? INK : MUTED, fontWeight: justSent ? 700 : 400 }}>
                {justSent ?? (liveText || (isRecording ? (current.reached ? "회신 녹음 중… (떼면 전송)" : "송신 중… (떼면 전송)") : current.reached ? "카드를 골라 누른 채 회신" : "버튼을 누른 채 말하세요"))}
              </p>
            </div>

            {micError && <p style={{ fontSize: 12, color: "#5a1a10", textAlign: "center", margin: 0 }}>{micError}</p>}

            {/* PUSH-TO-TALK */}
            <div style={{ display: "flex", justifyContent: "center" }}>
              <button
                onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); startRecording(); }}
                onPointerUp={() => stopRecording()}
                onPointerCancel={() => stopRecording()}
                onContextMenu={(e) => e.preventDefault()}
                style={{ ...talkKnob, transform: isRecording ? "scale(0.94)" : "scale(1)" }}
              >
                <span style={{ width: isRecording ? 26 : 22, height: isRecording ? 26 : 22, borderRadius: isRecording ? 5 : "50%", background: isRecording ? accent : "#fff", transition: "all 0.15s ease" }} />
              </button>
            </div>

            {/* 하단 액션 */}
            {!current.reached ? (
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn" onClick={reachTarget} disabled={isRecording} style={{ ...ghostBtn, flex: 1 }}>목표일로 가기 ▸</button>
                <button className="btn" onClick={newChannelForm} disabled={isRecording} style={ghostBtn}>+ 새 채널</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn" onClick={newChannelForm} disabled={isRecording} style={{ ...ghostBtn, flex: 1 }}>새 목표</button>
                <button className="btn" onClick={continueRun} disabled={isRecording} style={{ ...ghostBtn, whiteSpace: "nowrap" }}>이어서하기</button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ---- 스타일 ----
const shell: React.CSSProperties = { height: "100dvh", display: "flex", justifyContent: "center", overflow: "hidden", transition: "background 0.4s ease" };
const main: React.CSSProperties = { width: "100%", maxWidth: 420, height: "100%", padding: "26px 22px calc(20px + env(safe-area-inset-bottom))", display: "flex", flexDirection: "column", boxSizing: "border-box" };
const colFill: React.CSSProperties = { flex: 1, display: "flex", flexDirection: "column", gap: 16, minHeight: 0 };
const colFillTight: React.CSSProperties = { flex: 1, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 };

const eyebrow: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: MUTED, textTransform: "uppercase" };

const primaryBtn: React.CSSProperties = { background: INK, color: "#fff", border: "none", borderRadius: 9999, padding: "16px 22px", fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", width: "100%", cursor: "pointer" };
const ghostBtn: React.CSSProperties = { background: "rgba(0,0,0,0.10)", color: INK, border: "none", borderRadius: 9999, padding: "15px 18px", fontSize: 15, fontWeight: 600, cursor: "pointer" };

const chBar: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(0,0,0,0.08)", borderRadius: 12, padding: "6px 12px", flexShrink: 0 };
const chArrow: React.CSSProperties = { width: 40, height: 32, border: "none", background: "transparent", color: INK, fontSize: 22, cursor: "pointer", lineHeight: 1 };

const channelDisplay: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, background: INK, borderRadius: 14, padding: "18px 18px" };
const chTag: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#7dd87d", letterSpacing: 1, flexShrink: 0 };
const channelInput: React.CSSProperties = { flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "#fff", fontSize: 18, letterSpacing: 0.3 };

const dialRowDark: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, background: "rgba(255,255,255,0.08)", borderRadius: 16, padding: "14px 10px" };
const dialCol: React.CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: 1 };
const dialValue: React.CSSProperties = { fontSize: 30, fontWeight: 700, letterSpacing: 0.5, lineHeight: 1 };
const dialUnit: React.CSSProperties = { fontSize: 11, color: MUTED_L, fontWeight: 600 };
const dialSepDark: React.CSSProperties = { fontSize: 22, color: "rgba(255,255,255,0.28)", fontWeight: 300, marginTop: -14 };
const triBtn: React.CSSProperties = { border: "none", background: "transparent", color: "currentColor", fontSize: 13, cursor: "pointer", padding: 4, lineHeight: 1 };

const talkKnob: React.CSSProperties = { width: 86, height: 86, borderRadius: "50%", border: "none", background: INK, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", touchAction: "none", userSelect: "none", transition: "transform 0.1s ease", boxShadow: "0 6px 18px rgba(0,0,0,0.22)" };

const carouselStrip: React.CSSProperties = { position: "relative", height: 172, flexShrink: 0, display: "flex", gap: 12, overflowX: "auto", overflowY: "hidden", scrollSnapType: "x mandatory", scrollbarWidth: "none", WebkitOverflowScrolling: "touch" };
const snapCard: React.CSSProperties = { scrollSnapAlign: "center", flex: "0 0 84%", display: "flex", flexDirection: "column", padding: 16, overflowY: "auto", background: "rgba(0,0,0,0.13)", borderRadius: 16, color: INK };
const dotsRow: React.CSSProperties = { display: "flex", gap: 6, justifyContent: "center", alignItems: "center", flexShrink: 0 };

const voicePill: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 10, background: "rgba(255,255,255,0.4)", border: "none", borderRadius: 9999, padding: "8px 14px 8px 8px", cursor: "pointer", color: INK };
const voiceDot: React.CSSProperties = { width: 26, height: 26, borderRadius: "50%", color: "#fff", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
