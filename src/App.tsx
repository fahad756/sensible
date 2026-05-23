import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Bot,
  Camera,
  Check,
  Copy,
  ExternalLink,
  Eye,
  Headphones,
  Loader2,
  MonitorUp,
  Pause,
  Play,
  QrCode,
  Radio,
  ScanText,
  Smartphone,
  Sparkles,
  Square,
  Wifi,
  WifiOff
} from "lucide-react";
import QRCode from "qrcode";
import { io, Socket } from "socket.io-client";

type ContextForm = {
  role: string;
  projects: string;
  company: string;
};

type QuestionEvent = {
  id: string;
  at: number;
  source: string;
  question: string;
};

type AnswerEvent = {
  id: string;
  questionId: string;
  question: string;
  answer: string;
  model: string;
  latencyMs: number;
  at: number;
};

type SessionState = {
  roomId: string;
  createdAt: number;
  status: string;
  clientCount: number;
  questionCount: number;
  answerCount: number;
  context?: {
    role?: string;
    company?: string;
  };
  recentQuestions?: QuestionEvent[];
  recentAnswers?: AnswerEvent[];
};

type ServerReady = {
  socketId: string;
  geminiConfigured: boolean;
  primaryModel: string;
  fallbackModel: string;
  publicAppUrl?: string;
};

type CaptureStatus = {
  at: number;
  state: string;
  detail: string;
};

type TranscriptEvent = {
  at: number;
  text: string;
  source: string;
};

type PendingAnswer = {
  questionId: string;
  at: number;
};

type SharedAudioState = {
  available: boolean;
  label: string;
  readyState: string;
  muted: boolean;
  lastChunkAt?: number;
  lastResult?: string;
};

const defaultContext: ContextForm = {
  role: "Backend Automation Engineer",
  projects:
    "Describe your real projects, systems, metrics, technologies, tradeoffs, failures, and ownership. Sensible will synthesize from this context.",
  company: "Mock technical screening or explicitly permitted coaching session"
};

const interrogativeWords = [
  "what",
  "why",
  "how",
  "when",
  "where",
  "which",
  "who",
  "can you",
  "could you",
  "would you",
  "tell me",
  "walk me",
  "explain",
  "describe",
  "have you",
  "do you",
  "did you",
  "are you"
];

export default function App() {
  const initialRoom = useMemo(() => new URLSearchParams(window.location.search).get("room") || "", []);
  const initialViewer = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("viewer") === "mobile" || Boolean(params.get("room"));
  }, []);
  const initialAbout = useMemo(() => {
    return window.location.pathname === "/about" || new URLSearchParams(window.location.search).get("view") === "about";
  }, []);

  const [view, setView] = useState<"desktop" | "mobile" | "about">(initialViewer ? "mobile" : initialAbout ? "about" : "desktop");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [serverReady, setServerReady] = useState<ServerReady | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [context, setContext] = useState<ContextForm>(defaultContext);
  const [roomId, setRoomId] = useState(initialRoom.toUpperCase());
  const [joinInput, setJoinInput] = useState(initialRoom.toUpperCase());
  const [session, setSession] = useState<SessionState | null>(null);
  const [questions, setQuestions] = useState<QuestionEvent[]>([]);
  const [answers, setAnswers] = useState<AnswerEvent[]>([]);
  const [pending, setPending] = useState<PendingAnswer | null>(null);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [isCapturing, setIsCapturing] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(true);
  const [audioAssistEnabled, setAudioAssistEnabled] = useState(true);
  const [sharedAudio, setSharedAudio] = useState<SharedAudioState>({
    available: false,
    label: "",
    readyState: "none",
    muted: false
  });
  const [audioLevel, setAudioLevel] = useState(0);
  const [manualQuestion, setManualQuestion] = useState("");
  const [copied, setCopied] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastQuestionRef = useRef({ key: "", at: 0 });
  const visionTimerRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioBusyRef = useRef(false);
  const audioChunkBufferRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioLevelTimerRef = useRef<number | null>(null);
  const contextRef = useRef(context);
  const roomRef = useRef(roomId);

  const realtimeUrl = useMemo(getRealtimeUrl, []);
  const apiBase = realtimeUrl || "";

  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  useEffect(() => {
    roomRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    const nextSocket = io(realtimeUrl || window.location.origin, {
      transports: ["websocket", "polling"],
      reconnectionDelayMax: 1200
    });

    setSocket(nextSocket);
    nextSocket.on("connect", () => setSocketConnected(true));
    nextSocket.on("disconnect", () => setSocketConnected(false));
    nextSocket.on("server:ready", (payload: ServerReady) => setServerReady(payload));
    nextSocket.on("session:state", (payload: SessionState) => {
      setSession(payload);
      if (payload?.roomId) {
        setRoomId(payload.roomId);
        roomRef.current = payload.roomId;
      }
      if (payload?.recentQuestions?.length) setQuestions(payload.recentQuestions);
      if (payload?.recentAnswers?.length) setAnswers(payload.recentAnswers);
    });
    nextSocket.on("capture:status", (payload: CaptureStatus) => setCaptureStatus(payload));
    nextSocket.on("transcript:partial", (payload: TranscriptEvent) => {
      setPartialTranscript(payload.text);
    });
    nextSocket.on("question:new", (payload: QuestionEvent) => {
      setQuestions((current) => upsertById([payload, ...current], 30));
    });
    nextSocket.on("answer:pending", (payload: PendingAnswer) => setPending(payload));
    nextSocket.on("answer:ready", (payload: AnswerEvent) => {
      setPending(null);
      setAnswers((current) => upsertById([payload, ...current], 30));
      if (view === "mobile" && "vibrate" in navigator) {
        navigator.vibrate([35, 25, 35]);
      }
    });
    nextSocket.on("answer:error", (payload: { error: string }) => {
      setPending(null);
      setError(payload.error || "Sensible response failed.");
    });

    return () => {
      nextSocket.disconnect();
    };
  }, [realtimeUrl, view]);

  useEffect(() => {
    if (!roomId) {
      setQrDataUrl("");
      return;
    }

    const url = buildJoinUrl(roomId, serverReady?.publicAppUrl);
    QRCode.toDataURL(url, {
      margin: 1,
      width: 280,
      color: {
        dark: "#020617",
        light: "#f8fafc"
      }
    }).then(setQrDataUrl);
  }, [roomId, serverReady?.publicAppUrl]);

  useEffect(() => {
    if (view === "mobile" && initialRoom && socketConnected && socket) {
      joinSession(initialRoom);
    }
  }, [initialRoom, socket, socketConnected, view]);

  useEffect(() => {
    if (visionEnabled && isCapturing) {
      startVisionLoop();
    } else {
      stopVisionLoop();
    }

    return stopVisionLoop;
  }, [visionEnabled, isCapturing]);

  useEffect(() => {
    if (audioAssistEnabled && isCapturing) {
      startAudioAssist();
    } else {
      stopAudioAssist();
    }

    return stopAudioAssist;
  }, [audioAssistEnabled, isCapturing]);

  const createSession = useCallback(() => {
    if (!socket) return;
    setError("");
    setWarnings([]);

    socket.emit(
      "session:create",
      {
        context
      },
      (response: { ok: boolean; error?: string; roomId?: string; session?: SessionState }) => {
        if (!response.ok) {
          setError(response.error || "Could not create session.");
          return;
        }
        if (response.roomId) {
          setRoomId(response.roomId);
          setSession(response.session || null);
        }
      }
    );
  }, [context, socket]);

  const joinSession = useCallback(
    (value?: string) => {
      const requestedRoom = String(value || joinInput || "")
        .trim()
        .toUpperCase();
      if (!socket || !requestedRoom) return;
      setError("");

      socket.emit(
        "session:join",
        {
          roomId: requestedRoom,
          role: view === "desktop" ? "producer" : "viewer"
        },
        (response: { ok: boolean; error?: string; session?: SessionState }) => {
          if (!response.ok) {
            setError(response.error || "Could not join room.");
            return;
          }
          setRoomId(requestedRoom);
          setSession(response.session || null);
          if (response.session?.recentQuestions) setQuestions(response.session.recentQuestions);
          if (response.session?.recentAnswers) setAnswers(response.session.recentAnswers);
        }
      );
    },
    [joinInput, socket, view]
  );

  const startLiveSession = useCallback(async () => {
    setError("");
    setWarnings([]);

    if (!roomId) {
      createSession();
      await wait(150);
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen capture is not supported in this browser. Use current Chrome or Edge on desktop.");
      return;
    }

    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      setError("Screen capture requires HTTPS in production. Use HTTPS or localhost for development.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 30 },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      streamRef.current = stream;
      setIsCapturing(true);
      emitCaptureStatus("streaming", "Screen capture started.");

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        setSharedAudio({
          available: false,
          label: "",
          readyState: "none",
          muted: false,
          lastResult: "No shared audio track. Pick a browser tab and enable Share audio."
        });
        setWarnings((current) => [
          ...current,
          "No screen-audio track was shared. In Chrome/Edge, choose a tab or screen source that exposes audio and enable Share audio."
        ]);
      } else {
        const primaryAudioTrack = audioTracks[0];
        setSharedAudio({
          available: true,
          label: primaryAudioTrack.label || "Shared screen audio",
          readyState: primaryAudioTrack.readyState,
          muted: primaryAudioTrack.muted,
          lastResult: "Shared audio track detected. Waiting for sound."
        });
        primaryAudioTrack.addEventListener("mute", () => {
          setSharedAudio((current) => ({ ...current, muted: true, lastResult: "Audio track is muted by the browser/source." }));
        });
        primaryAudioTrack.addEventListener("unmute", () => {
          setSharedAudio((current) => ({ ...current, muted: false, lastResult: "Shared audio track is live." }));
        });
        primaryAudioTrack.addEventListener("ended", () => {
          setSharedAudio((current) => ({ ...current, readyState: "ended", lastResult: "Shared audio track ended." }));
        });
        startAudioLevelMonitor(audioTracks);
      }

      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        stopCapture();
        emitCaptureStatus("stopped", "Screen sharing was stopped from the browser control.");
      });
    } catch (captureError) {
      setError(describeCaptureError(captureError));
      emitCaptureStatus("error", describeCaptureError(captureError));
    }
  }, [createSession, roomId]);

  const stopCapture = useCallback(() => {
    stopVisionLoop();
    stopAudioAssist();
    stopAudioLevelMonitor();

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsCapturing(false);
    setAudioLevel(0);
    setSharedAudio({
      available: false,
      label: "",
      readyState: "none",
      muted: false
    });
    emitCaptureStatus("stopped", "Capture stopped.");
  }, []);

  const maybeSubmitQuestion = useCallback(
    (text: string, source: string) => {
      const question = extractQuestion(text);
      if (!question || !socket) return;

      const key = question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const now = Date.now();
      if (lastQuestionRef.current.key === key && now - lastQuestionRef.current.at < 12000) return;

      lastQuestionRef.current = { key, at: now };
      socket.emit("question:detected", {
        roomId: roomRef.current,
        question,
        source
      });
    },
    [socket]
  );

  const submitManualQuestion = useCallback(() => {
    const text = manualQuestion.trim();
    if (!text || !socket) return;
    setManualQuestion("");
    socket.emit("question:detected", {
      roomId,
      question: text,
      source: "manual"
    });
  }, [manualQuestion, roomId, socket]);

  function emitCaptureStatus(state: string, detail: string) {
    socket?.emit("capture:status", { state, detail });
    setCaptureStatus({ at: Date.now(), state, detail });
  }

  function startVisionLoop() {
    stopVisionLoop();
    visionTimerRef.current = window.setInterval(async () => {
      const video = videoRef.current;
      if (!video || !streamRef.current || video.readyState < 2) return;

      try {
        const dataUrl = captureVideoFrame(video);
        const response = await fetch(`${apiBase}/api/gemini/vision-question`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageDataUrl: dataUrl,
            context: contextRef.current
          })
        });
        const payload = await response.json();
        if (payload.ok && payload.question && payload.confidence >= 0.55) {
          setPartialTranscript(payload.question);
          socket?.emit("transcript:partial", {
            text: payload.question,
            source: "screen-vision"
          });
          maybeSubmitQuestion(payload.question, "vision");
        }
      } catch (visionError) {
        setWarnings((current) => uniqueList([...current, `Screen text scan issue: ${shortError(visionError)}`]));
      }
    }, 10000);
  }

  function stopVisionLoop() {
    if (visionTimerRef.current) {
      window.clearInterval(visionTimerRef.current);
      visionTimerRef.current = null;
    }
  }

  function startAudioAssist() {
    stopAudioAssist();
    const audioTracks = streamRef.current?.getAudioTracks() || [];
    if (!audioTracks.length) {
      setSharedAudio((current) => ({
        ...current,
        available: false,
        lastResult: "No shared audio track is available to analyze."
      }));
      setWarnings((current) => uniqueList([...current, "Shared audio scan needs a screen-share audio track. Pick a Chrome/Edge tab and enable Share audio."]));
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";

    try {
      const recorder = new MediaRecorder(new MediaStream(audioTracks), mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      audioChunkBufferRef.current = [];
      setSharedAudio((current) => ({
        ...current,
        available: true,
        readyState: audioTracks[0]?.readyState || "live",
        muted: Boolean(audioTracks[0]?.muted),
        lastResult: "Shared audio scan is armed."
      }));

      recorder.ondataavailable = async (event) => {
        if (!event.data.size) return;

        audioChunkBufferRef.current = [...audioChunkBufferRef.current, event.data].slice(-3);
        setSharedAudio((current) => ({
          ...current,
          lastChunkAt: Date.now(),
          lastResult: audioBusyRef.current ? "Audio captured; waiting for current Sensible check." : "Audio captured; checking for a question."
        }));

        if (audioBusyRef.current) return;

        audioBusyRef.current = true;
        try {
          const combinedType = recorder.mimeType || event.data.type || "audio/webm";
          const combinedAudio = new Blob(audioChunkBufferRef.current, { type: combinedType });
          const dataUrl = await blobToDataUrl(combinedAudio);
          const response = await fetch(`${apiBase}/api/gemini/audio-question`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              audioDataUrl: dataUrl,
              context: contextRef.current
            })
          });
          const payload = await response.json();
          if (!payload.ok) {
            throw new Error(payload.error || "Sensible audio check failed.");
          }

          if (payload.question && payload.confidence >= 0.35) {
            setPartialTranscript(payload.question);
            socket?.emit("transcript:partial", {
              text: payload.question,
              source: "screen-audio"
            });
            maybeSubmitQuestion(payload.question, "screen-audio");
            setSharedAudio((current) => ({
              ...current,
              lastResult: `Question detected from shared audio (${Math.round(payload.confidence * 100)}%).`
            }));
          } else {
            setSharedAudio((current) => ({
              ...current,
              lastResult: "Shared audio heard; no clear question in the latest window."
            }));
          }
        } catch (audioError) {
          setSharedAudio((current) => ({
            ...current,
            lastResult: `Audio scan failed: ${shortError(audioError)}`
          }));
          setWarnings((current) => uniqueList([...current, `Shared audio scan issue: ${shortError(audioError)}`]));
        } finally {
          audioBusyRef.current = false;
        }
      };
      recorder.onerror = () => {
        setSharedAudio((current) => ({
          ...current,
          lastResult: "Browser MediaRecorder reported an audio recording error."
        }));
      };
      recorder.start(8000);
    } catch (audioError) {
      setWarnings((current) => uniqueList([...current, `Could not start shared audio scan: ${shortError(audioError)}`]));
    }
  }

  function stopAudioAssist() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    audioBusyRef.current = false;
    audioChunkBufferRef.current = [];
  }

  function startAudioLevelMonitor(audioTracks: MediaStreamTrack[]) {
    stopAudioLevelMonitor();
    if (!audioTracks.length) return;

    const audioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!audioContextCtor) {
      setWarnings((current) => uniqueList([...current, "This browser cannot show shared-audio levels. Detection can still run if MediaRecorder supports the track."]));
      return;
    }

    try {
      const audioContext = new audioContextCtor();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.72;
      const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
      source.connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      audioContextRef.current = audioContext;
      audioSourceRef.current = source;
      audioLevelTimerRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / samples.length);
        setAudioLevel(Math.min(1, rms * 5));
        setSharedAudio((current) => ({
          ...current,
          readyState: audioTracks[0]?.readyState || current.readyState,
          muted: Boolean(audioTracks[0]?.muted)
        }));
      }, 250);
    } catch (levelError) {
      setWarnings((current) => uniqueList([...current, `Could not inspect shared-audio levels: ${shortError(levelError)}`]));
    }
  }

  function stopAudioLevelMonitor() {
    if (audioLevelTimerRef.current) {
      window.clearInterval(audioLevelTimerRef.current);
      audioLevelTimerRef.current = null;
    }
    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
  }

  const latestAnswer = answers[0];
  const latestQuestion = questions[0];
  const joinUrl = roomId ? buildJoinUrl(roomId, serverReady?.publicAppUrl) : "";

  if (view === "mobile") {
    return (
      <MobileView
        socketConnected={socketConnected}
        serverReady={serverReady}
        roomId={roomId}
        joinInput={joinInput}
        setJoinInput={setJoinInput}
        joinSession={joinSession}
        error={error}
        session={session}
        latestAnswer={latestAnswer}
        latestQuestion={latestQuestion}
        answers={answers}
        questions={questions}
        pending={pending}
        partialTranscript={partialTranscript}
        captureStatus={captureStatus}
        switchToDesktop={() => setView("desktop")}
        switchToAbout={() => setView("about")}
        socket={socket}
        apiBase={apiBase}
        context={context}
      />
    );
  }

  if (view === "about") {
    return <AboutView switchToDesktop={() => setView("desktop")} switchToMobile={() => setView("mobile")} />;
  }

  return (
    <div className="min-h-screen px-5 py-5 text-slate-100 lg:px-8">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-5">
        <header className="flex flex-col gap-4 rounded-lg border border-slate-800/80 bg-slate-950/70 px-4 py-4 shadow-glow backdrop-blur md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Logo />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <BrandWordmark className="text-2xl" />
              </div>
              <p className="mt-1 text-sm text-slate-400">Desktop capture, paired mobile viewer, Sensible drafting.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ConnectionPill connected={socketConnected} />
            <ModelPill serverReady={serverReady} />
            <button
              className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-cyan-400/70 hover:text-cyan-100"
              onClick={() => setView("about")}
              type="button"
            >
              <BookOpen size={16} />
              How to Use
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-cyan-400/70 hover:text-cyan-100"
              onClick={() => setView("mobile")}
              type="button"
            >
              <Smartphone size={16} />
              Switch to Phone View
            </button>
          </div>
        </header>

        <main className="grid gap-5 xl:grid-cols-[440px_minmax(0,1fr)]">
          <section className="glass rounded-lg p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Session Setup</h2>
                <p className="mt-1 text-sm text-slate-400">Ground every answer in your real practice context.</p>
              </div>
              <Logo small />
            </div>

            <div className="mt-5 space-y-4">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-slate-300">Interview subject / role</span>
                <input
                  value={context.role}
                  onChange={(event) => setContext({ ...context, role: event.target.value })}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-3 text-slate-100 placeholder:text-slate-600"
                  placeholder="Backend Automation Engineer"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-slate-300">Project descriptions & core experience</span>
                <textarea
                  value={context.projects}
                  onChange={(event) => setContext({ ...context, projects: event.target.value })}
                  className="min-h-48 w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-3 text-sm leading-6 text-slate-100 placeholder:text-slate-600"
                  placeholder="Paste detailed project background, metrics, stack, ownership, constraints, tradeoffs..."
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-slate-300">Target company / session context</span>
                <textarea
                  value={context.company}
                  onChange={(event) => setContext({ ...context, company: event.target.value })}
                  className="min-h-24 w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-3 text-sm leading-6 text-slate-100 placeholder:text-slate-600"
                  placeholder="Mock technical screen, coaching scenario, company notes..."
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={createSession}
                  disabled={!socketConnected}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-cyan-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  <QrCode size={18} />
                  Create Room
                </button>

                <button
                  type="button"
                  onClick={isCapturing ? stopCapture : startLiveSession}
                  disabled={!socketConnected}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  {isCapturing ? <Square size={18} /> : <Play size={18} />}
                  {isCapturing ? "Stop Session" : "Start Live Session"}
                </button>
              </div>
            </div>
          </section>

          <section className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-5">
              <div className="glass rounded-lg p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Capture Stream</h2>
                    <p className="mt-1 text-sm text-slate-400">Screen preview, on-screen question scan, and screen-share audio detection.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge active={isCapturing} activeLabel="Streaming" inactiveLabel="Idle" icon={<Radio size={15} />} />
                    <StatusBadge active={audioAssistEnabled && isCapturing} activeLabel="Screen Audio" inactiveLabel="Audio Scan" icon={<Headphones size={15} />} />
                  </div>
                </div>

                <div className="mt-4 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
                  <div className="relative aspect-video">
                    <video ref={videoRef} muted playsInline className="h-full w-full bg-slate-950 object-contain" />
                    {!isCapturing && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-500">
                        <MonitorUp size={44} />
                        <p className="max-w-sm text-center text-sm">Start capture and choose a screen, window, or browser tab. Enable shared audio when your browser exposes it.</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <ToggleCard
                    enabled={visionEnabled}
                    setEnabled={setVisionEnabled}
                    icon={<ScanText size={18} />}
                    title="Screen Text Scan"
                    detail="Reads visible questions from the shared screen."
                    status={isCapturing ? "Scanning every 10s" : "Ready before capture"}
                  />
                  <ToggleCard
                    enabled={audioAssistEnabled}
                    setEnabled={setAudioAssistEnabled}
                    icon={<Headphones size={18} />}
                    title="Screen Audio Scan"
                    detail="Uses only the audio track from screen sharing. No mic."
                    status={
                      sharedAudio.available
                        ? `${sharedAudio.readyState}${sharedAudio.muted ? " · muted" : ""}`
                        : "No shared audio track yet"
                    }
                    meter={sharedAudio.available ? audioLevel : undefined}
                    badge={sharedAudio.available ? "TRACK FOUND" : "WAITING"}
                  />
                </div>
              </div>

              <div className="grid gap-5 lg:grid-cols-2">
                <div className="glass rounded-lg p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="font-semibold text-white">Detection Feed</h3>
                    <Activity size={17} className="text-cyan-300" />
                  </div>
                  <div className="min-h-28 rounded-md border border-slate-800 bg-slate-950 p-3 text-sm leading-6 text-slate-300">
                    {partialTranscript || "Screen text and screen-audio detections appear here."}
                  </div>
                  <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/80 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Shared Audio Level</span>
                      <span className={sharedAudio.available ? "text-xs text-emerald-300" : "text-xs text-amber-300"}>
                        {sharedAudio.available ? "track detected" : "no track"}
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-cyan-300 to-blue-400 transition-[width]"
                        style={{ width: `${Math.round(audioLevel * 100)}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {sharedAudio.lastResult ||
                        "When a browser tab is shared with audio, this meter should move while the interview audio plays."}
                    </p>
                    {sharedAudio.label && <p className="mt-1 truncate text-xs text-slate-600">{sharedAudio.label}</p>}
                  </div>
                  {captureStatus && (
                    <p className="mt-3 text-xs text-slate-500">
                      {captureStatus.state}: {captureStatus.detail}
                    </p>
                  )}
                </div>

                <div className="glass rounded-lg p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="font-semibold text-white">Manual Question</h3>
                    <Bot size={17} className="text-emerald-300" />
                  </div>
                  <textarea
                    value={manualQuestion}
                    onChange={(event) => setManualQuestion(event.target.value)}
                    className="min-h-28 w-full resize-none rounded-md border border-slate-800 bg-slate-950 p-3 text-sm leading-6 text-slate-200 placeholder:text-slate-600"
                    placeholder="Type or paste a practice question if screen/audio detection misses it."
                  />
                  <button
                    type="button"
                    onClick={submitManualQuestion}
                    disabled={!roomId || !manualQuestion.trim()}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-100 px-4 py-2.5 font-semibold text-slate-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    <Sparkles size={16} />
                    Generate Practice Answer
                  </button>
                </div>
              </div>

              <EventPanels
                questions={questions}
                answers={answers}
                pending={pending}
                error={error}
                warnings={warnings}
              />
            </div>

            <aside className="space-y-5">
              <div className="glass rounded-lg p-4">
                <h2 className="text-lg font-semibold text-white">Pair Phone</h2>
                <p className="mt-1 text-sm text-slate-400">Scan or enter the room ID on your mobile device.</p>

                <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950 p-3">
                  {roomId ? (
                    <div className="space-y-3">
                      {qrDataUrl ? (
                        <img src={qrDataUrl} alt="Room QR code" className="mx-auto h-56 w-56 rounded-md bg-white p-2" />
                      ) : (
                        <div className="flex h-56 items-center justify-center">
                          <Loader2 className="animate-spin text-cyan-300" />
                        </div>
                      )}
                      <div className="rounded-md border border-slate-800 bg-slate-900 p-3 text-center">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Room ID</p>
                        <p className="mt-1 text-3xl font-black tracking-normal text-white">{roomId}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-72 flex-col items-center justify-center gap-3 text-center text-slate-500">
                      <QrCode size={42} />
                      <p className="text-sm">Create a room to generate the QR code.</p>
                    </div>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={!joinUrl}
                    onClick={async () => {
                      await navigator.clipboard.writeText(joinUrl);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1300);
                    }}
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm font-medium text-slate-200 transition hover:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    {copied ? "Copied" : "Copy Link"}
                  </button>
                  <a
                    href={joinUrl || "#"}
                    target="_blank"
                    rel="noreferrer"
                    className={`inline-flex items-center justify-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm font-medium text-slate-200 transition hover:border-cyan-400 ${!joinUrl ? "pointer-events-none opacity-50" : ""}`}
                  >
                    <ExternalLink size={16} />
                    Open
                  </a>
                </div>
              </div>

              <div className="glass rounded-lg p-4">
                <h2 className="text-lg font-semibold text-white">Instant Card Preview</h2>
                <div className="mt-4 rounded-lg border border-cyan-400/25 bg-gradient-to-br from-slate-950 to-slate-900 p-4">
                  {pending && !latestAnswer ? (
                    <LoadingAnswer />
                  ) : latestAnswer ? (
                    <AnswerCard answer={latestAnswer} compact />
                  ) : (
                    <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center text-slate-500">
                      <Sparkles size={36} />
                      <p className="text-sm">Sensible answer drafts appear here and on mobile.</p>
                    </div>
                  )}
                </div>
              </div>

              {!serverReady?.geminiConfigured && (
                <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-4 text-sm leading-6 text-amber-100">
                  <div className="mb-2 flex items-center gap-2 font-semibold">
                    <AlertTriangle size={17} />
                    Sensible engine key missing
                  </div>
                  Set the server API key. Sensible intentionally does not ship provider keys to the browser.
                </div>
              )}
            </aside>
          </section>
        </main>
      </div>
    </div>
  );
}

function MobileView({
  socketConnected,
  serverReady,
  roomId,
  joinInput,
  setJoinInput,
  joinSession,
  error,
  session,
  latestAnswer,
  latestQuestion,
  answers,
  questions,
  pending,
  partialTranscript,
  captureStatus,
  switchToDesktop,
  switchToAbout,
  socket,
  apiBase,
  context
}: {
  socketConnected: boolean;
  serverReady: ServerReady | null;
  roomId: string;
  joinInput: string;
  setJoinInput: (value: string) => void;
  joinSession: (value?: string) => void;
  error: string;
  session: SessionState | null;
  latestAnswer?: AnswerEvent;
  latestQuestion?: QuestionEvent;
  answers: AnswerEvent[];
  questions: QuestionEvent[];
  pending: PendingAnswer | null;
  partialTranscript: string;
  captureStatus: CaptureStatus | null;
  switchToDesktop: () => void;
  switchToAbout: () => void;
  socket: import("socket.io-client").Socket | null;
  apiBase: string;
  context: ContextForm;
}) {
  const [mobileCapturing, setMobileCapturing] = useState(false);
  const [mobilePaused, setMobilePaused] = useState(false);
  const [mobileError, setMobileError] = useState("");
  const [mobileDetected, setMobileDetected] = useState("");

  const mobileVideoRef = useRef<HTMLVideoElement | null>(null);
  const mobileStreamRef = useRef<MediaStream | null>(null);
  const mobileVisionTimerRef = useRef<number | null>(null);
  const mobileRecorderRef = useRef<MediaRecorder | null>(null);
  const mobileAudioBusyRef = useRef(false);
  const mobileAudioChunksRef = useRef<Blob[]>([]);
  const mobileContextRef = useRef(context);
  const mobileRoomRef = useRef(roomId);

  useEffect(() => { mobileContextRef.current = context; }, [context]);
  useEffect(() => { mobileRoomRef.current = roomId; }, [roomId]);

  useEffect(() => {
    return () => {
      stopMobileCapture();
    };
  }, []);

  async function startMobileCapture() {
    setMobileError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      mobileStreamRef.current = stream;
      if (mobileVideoRef.current) {
        mobileVideoRef.current.srcObject = stream;
        await mobileVideoRef.current.play().catch(() => undefined);
      }
      setMobileCapturing(true);
      setMobilePaused(false);
      startMobileVisionLoop();
      startMobileAudioRecorder(stream);
    } catch (err) {
      setMobileError(err instanceof Error ? err.message : "Could not access camera or microphone.");
    }
  }

  function pauseMobileCapture() {
    stopMobileVisionLoop();
    if (mobileRecorderRef.current?.state === "recording") {
      mobileRecorderRef.current.pause();
    }
    setMobilePaused(true);
  }

  function resumeMobileCapture() {
    startMobileVisionLoop();
    if (mobileRecorderRef.current?.state === "paused") {
      mobileRecorderRef.current.resume();
    }
    setMobilePaused(false);
  }

  function stopMobileCapture() {
    stopMobileVisionLoop();
    if (mobileRecorderRef.current && mobileRecorderRef.current.state !== "inactive") {
      mobileRecorderRef.current.stop();
    }
    mobileRecorderRef.current = null;
    mobileAudioBusyRef.current = false;
    mobileAudioChunksRef.current = [];
    mobileStreamRef.current?.getTracks().forEach((t) => t.stop());
    mobileStreamRef.current = null;
    if (mobileVideoRef.current) mobileVideoRef.current.srcObject = null;
    setMobileCapturing(false);
    setMobilePaused(false);
  }

  function startMobileVisionLoop() {
    stopMobileVisionLoop();
    mobileVisionTimerRef.current = window.setInterval(async () => {
      const video = mobileVideoRef.current;
      if (!video || video.readyState < 2) return;
      try {
        const dataUrl = captureVideoFrame(video);
        const res = await fetch(`${apiBase}/api/gemini/vision-question`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageDataUrl: dataUrl, context: mobileContextRef.current })
        });
        const payload = await res.json();
        if (payload.ok && payload.question && payload.confidence >= 0.55) {
          setMobileDetected(payload.question);
          socket?.emit("question:detected", { roomId: mobileRoomRef.current, question: payload.question, source: "mobile-vision" });
        }
      } catch {
        // silent — vision errors are non-critical
      }
    }, 10000);
  }

  function stopMobileVisionLoop() {
    if (mobileVisionTimerRef.current) {
      window.clearInterval(mobileVisionTimerRef.current);
      mobileVisionTimerRef.current = null;
    }
  }

  function startMobileAudioRecorder(stream: MediaStream) {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    try {
      const recorder = new MediaRecorder(new MediaStream(audioTracks), mimeType ? { mimeType } : undefined);
      mobileRecorderRef.current = recorder;
      mobileAudioChunksRef.current = [];

      recorder.ondataavailable = async (event) => {
        if (!event.data.size) return;
        mobileAudioChunksRef.current = [...mobileAudioChunksRef.current, event.data].slice(-3);
        if (mobileAudioBusyRef.current) return;
        mobileAudioBusyRef.current = true;
        try {
          const combinedType = recorder.mimeType || event.data.type || "audio/webm";
          const blob = new Blob(mobileAudioChunksRef.current, { type: combinedType });
          const dataUrl = await blobToDataUrl(blob);
          const res = await fetch(`${apiBase}/api/gemini/audio-question`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audioDataUrl: dataUrl, context: mobileContextRef.current })
          });
          const payload = await res.json();
          if (payload.ok && payload.question && payload.confidence >= 0.35) {
            setMobileDetected(payload.question);
            socket?.emit("question:detected", { roomId: mobileRoomRef.current, question: payload.question, source: "mobile-audio" });
          }
        } catch {
          // silent
        } finally {
          mobileAudioBusyRef.current = false;
        }
      };
      recorder.start(8000);
    } catch (err) {
      setMobileError(err instanceof Error ? err.message : "Could not start audio recorder.");
    }
  }

  return (
    <div className="safe-mobile bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-4 py-4">
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex min-w-0 items-center gap-3">
            <Logo small />
            <div className="min-w-0">
              <BrandWordmark className="text-lg" />
              <p className="truncate text-xs text-slate-500">{roomId ? `Room ${roomId}` : "Join mobile viewer"}</p>
            </div>
          </div>
          <ConnectionPill connected={socketConnected} compact />
        </header>

        {!roomId || !session ? (
          <section className="flex flex-1 flex-col justify-center gap-4">
            <div>
              <h2 className="text-3xl font-black tracking-normal text-white">Join room</h2>
              <p className="mt-2 text-base leading-7 text-slate-400">Enter the room ID to start capturing.</p>
            </div>
            <input
              value={joinInput}
              onChange={(event) => setJoinInput(event.target.value.toUpperCase())}
              className="h-16 rounded-md border border-slate-700 bg-slate-900 px-4 text-center text-2xl font-black tracking-[0.16em] text-white placeholder:text-slate-600"
              placeholder="ABC123"
              maxLength={8}
            />
            <button
              onClick={() => joinSession()}
              className="inline-flex h-14 items-center justify-center gap-2 rounded-md bg-cyan-400 px-4 text-lg font-black text-slate-950"
              type="button"
            >
              <Wifi size={21} />
              Join Session
            </button>
            {error && <ErrorBox message={error} />}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={switchToDesktop} className="rounded-md border border-slate-800 px-3 py-2 text-sm text-slate-400" type="button">
                Desktop setup
              </button>
              <button onClick={switchToAbout} className="rounded-md border border-slate-800 px-3 py-2 text-sm text-slate-400" type="button">
                How to use
              </button>
            </div>
          </section>
        ) : (
          <main className="flex flex-1 flex-col gap-4 py-4">
            {/* Capture controls */}
            <section className="rounded-lg border border-slate-700 bg-slate-900 p-3">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Capture</p>
                {mobileCapturing && !mobilePaused && (
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                    Live
                  </span>
                )}
                {mobilePaused && (
                  <span className="text-xs font-semibold text-amber-300">Paused</span>
                )}
              </div>

              <video ref={mobileVideoRef} muted playsInline className={`mb-3 w-full rounded-md bg-slate-950 object-cover ${mobileCapturing && !mobilePaused ? "block aspect-video" : "hidden"}`} />

              <div className="flex gap-2">
                {!mobileCapturing ? (
                  <button
                    type="button"
                    onClick={startMobileCapture}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 py-3 font-semibold text-slate-950"
                  >
                    <Camera size={18} />
                    Start Capture
                  </button>
                ) : mobilePaused ? (
                  <button
                    type="button"
                    onClick={resumeMobileCapture}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-cyan-400 px-4 py-3 font-semibold text-slate-950"
                  >
                    <Play size={18} />
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={pauseMobileCapture}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-amber-400 px-4 py-3 font-semibold text-slate-950"
                  >
                    <Pause size={18} />
                    Pause
                  </button>
                )}
                {mobileCapturing && (
                  <button
                    type="button"
                    onClick={stopMobileCapture}
                    className="flex items-center justify-center gap-2 rounded-md bg-slate-700 px-4 py-3 font-semibold text-slate-200"
                  >
                    <Square size={18} />
                    Stop
                  </button>
                )}
              </div>

              {mobileDetected && (
                <p className="mt-3 line-clamp-2 rounded-md bg-slate-950 p-2 text-sm leading-6 text-slate-300">
                  {mobileDetected}
                </p>
              )}
              {mobileError && <div className="mt-2"><ErrorBox message={mobileError} /></div>}
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Latest Question</p>
                <span className="text-xs text-slate-500">{latestQuestion ? timeAgo(latestQuestion.at) : ""}</span>
              </div>
              <p className="text-xl font-semibold leading-8 text-white">{latestQuestion?.question || "No question detected yet."}</p>
            </section>

            <section className="flex-1 rounded-lg border border-emerald-400/25 bg-gradient-to-br from-slate-900 to-slate-950 p-4 shadow-glow">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-emerald-200">Instant Practice Answer</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {latestAnswer ? `Sensible - ${latestAnswer.latencyMs}ms` : "Sensible Engine"}
                  </p>
                </div>
                {pending ? <Loader2 className="animate-spin text-emerald-300" /> : <Sparkles className="text-emerald-300" />}
              </div>
              {pending && !latestAnswer ? (
                <LoadingAnswer mobile />
              ) : latestAnswer ? (
                <AnswerCard answer={latestAnswer} mobile />
              ) : (
                <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center text-slate-500">
                  <Bot size={42} />
                  <p className="max-w-xs text-base leading-7">Tap Start Capture, point your camera at the interview screen, and answers will appear here.</p>
                </div>
              )}
            </section>

            <section className="grid grid-cols-2 gap-3">
              <Metric label="Questions" value={questions.length} />
              <Metric label="Answers" value={answers.length} />
            </section>

            {error && <ErrorBox message={error} />}
          </main>
        )}
      </div>
    </div>
  );
}

function AboutView({
  switchToDesktop,
  switchToMobile
}: {
  switchToDesktop: () => void;
  switchToMobile: () => void;
}) {
  const steps = [
    {
      title: "Fill in Session Setup",
      body: "Add the role, your project notes, and the company or screening context. This is what Sensible uses to shape answers around your actual background.",
      images: [
        {
          src: "/screenshots/session-setup.png",
          alt: "Session Setup panel with role, project notes, and company context fields",
          label: "Session Setup"
        }
      ]
    },
    {
      title: "Click Create Room",
      body: "After the setup fields look right, click Create Room. Sensible will generate a private room ID and QR code for this session.",
      images: [
        {
          src: "/screenshots/create-room.png",
          alt: "Create Room button in the Session Setup panel",
          label: "Create Room"
        },
        {
          src: "/screenshots/pair-phone.png",
          alt: "Pair Phone panel with QR code and room ID",
          label: "Room ID and QR"
        }
      ]
    },
    {
      title: "Open the room on your phone",
      body: "Scan the QR code with your phone. If you are testing on the same device, click Switch to Phone View and type the Room ID shown on desktop.",
      images: [
        {
          src: "/screenshots/phone-join.png",
          alt: "Phone view with Room ID input",
          label: "Phone Join Screen"
        },
        {
          src: "/screenshots/pair-phone.png",
          alt: "Desktop Pair Phone panel with the Room ID",
          label: "Desktop Room ID"
        }
      ]
    },
    {
      title: "Click Start Live Session",
      body: "Click Start Live Session. When the browser asks what to share, choose the tab or screen where the interview is running. If the voice is playing from a browser tab, enable Share audio.",
      images: [
        {
          src: "/screenshots/start-live-session.png",
          alt: "Start Live Session button in the Session Setup panel",
          label: "Start Capture"
        },
        {
          src: "/screenshots/capture-controls.png",
          alt: "Capture Stream panel with screen and audio scan controls",
          label: "Capture Status"
        }
      ]
    },
    {
      title: "Watch answers on desktop and phone",
      body: "On desktop, answers show in Instant Card Preview and Sensible Answers. On your phone, the same answer card updates in the phone view.",
      images: [
        {
          src: "/screenshots/desktop-answer.png",
          alt: "Desktop Instant Card Preview with a Sensible answer",
          label: "Desktop Answer Area"
        },
        {
          src: "/screenshots/phone-view.png",
          alt: "Phone view with latest question and answer card",
          label: "Phone Answer Card"
        }
      ]
    }
  ];

  const checks = [
    "The desktop shows a Room ID and QR code.",
    "The phone has joined the same Room ID.",
    "The screen preview shows the interview tab or screen.",
    "If you need spoken audio, Screen Audio Scan says TRACK FOUND and the meter moves.",
    "Answers appear in Instant Card Preview, Sensible Answers, and the phone answer card."
  ];

  return (
    <div className="min-h-screen px-5 py-5 text-slate-100 lg:px-8">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-5">
        <header className="flex flex-col gap-4 rounded-lg border border-slate-800/80 bg-slate-950/70 px-4 py-4 shadow-glow backdrop-blur md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Logo />
            <div>
              <BrandWordmark className="text-2xl" />
              <p className="mt-1 text-sm text-slate-400">A simple setup guide for running a live Sensible session.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-cyan-400/70 hover:text-cyan-100"
              onClick={switchToDesktop}
              type="button"
            >
              <ArrowLeft size={16} />
              Back to Dashboard
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-cyan-400/70 hover:text-cyan-100"
              onClick={switchToMobile}
              type="button"
            >
              <Smartphone size={16} />
              Switch to Phone View
            </button>
          </div>
        </header>

        <section className="rounded-lg border border-slate-800 bg-slate-950/70 p-5">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">How to use Sensible</p>
            <h1 className="mt-3 text-3xl font-black tracking-normal text-white md:text-4xl">Set up the desktop, pair the phone, then start the live screen share.</h1>
            <p className="mt-4 text-base leading-7 text-slate-400">
              Sensible works best when your desktop captures the interview screen and your phone shows the answer card. These steps are the normal flow.
            </p>
          </div>
        </section>

        <section className="grid gap-5">
          {steps.map((step, index) => (
            <article key={step.title} className="grid gap-4 rounded-lg border border-slate-800 bg-slate-950/70 p-4 lg:grid-cols-[340px_minmax(0,1fr)]">
              <div>
                <div className="mb-3 grid h-9 w-9 place-items-center rounded-md bg-cyan-400 text-sm font-black text-slate-950">{index + 1}</div>
                <h2 className="text-xl font-bold text-white">{step.title}</h2>
                <p className="mt-3 text-sm leading-6 text-slate-400">{step.body}</p>
              </div>
              <div className={`grid gap-3 ${step.images.length > 1 ? "md:grid-cols-2" : ""}`}>
                {step.images.map((image) => (
                  <figure key={image.src} className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
                    <img src={image.src} alt={image.alt} className="max-h-[460px] w-full object-contain object-top" />
                    <figcaption className="border-t border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      {image.label}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </article>
          ))}
        </section>

        <section className="rounded-lg border border-emerald-400/25 bg-emerald-400/10 p-5">
          <h2 className="text-lg font-bold text-emerald-100">Quick check before you begin</h2>
          <ul className="mt-4 grid gap-3 text-sm leading-6 text-emerald-50 md:grid-cols-2">
            {checks.map((check) => (
              <li key={check} className="flex items-start gap-3 rounded-md border border-emerald-400/20 bg-slate-950/35 p-3">
                <Check className="mt-0.5 shrink-0 text-emerald-300" size={17} />
                <span>{check}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function EventPanels({
  questions,
  answers,
  pending,
  error,
  warnings
}: {
  questions: QuestionEvent[];
  answers: AnswerEvent[];
  pending: PendingAnswer | null;
  error: string;
  warnings: string[];
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="glass rounded-lg p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold text-white">Detected Questions</h3>
          <span className="text-xs text-slate-500">{questions.length} captured</span>
        </div>
        <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
          {questions.length ? (
            questions.map((item) => (
              <div key={item.id} className="rounded-md border border-slate-800 bg-slate-950 p-3">
                <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500">
                  <span className="rounded-full border border-slate-700 px-2 py-1">{item.source}</span>
                  <span>{timeAgo(item.at)}</span>
                </div>
                <p className="text-sm leading-6 text-slate-200">{item.question}</p>
              </div>
            ))
          ) : (
            <EmptyState icon={<Eye size={28} />} text="Detected practice questions will appear here." />
          )}
        </div>
      </div>

      <div className="glass rounded-lg p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold text-white">Sensible Answers</h3>
          {pending && <Loader2 size={17} className="animate-spin text-emerald-300" />}
        </div>
        <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
          {error && <ErrorBox message={error} />}
          {warnings.map((warning) => (
            <WarningBox key={warning} message={warning} />
          ))}
          {answers.length ? (
            answers.map((item) => <AnswerCard key={item.id} answer={item} />)
          ) : (
            <EmptyState icon={<Sparkles size={28} />} text="Answer drafts will appear after a question is submitted." />
          )}
        </div>
      </div>
    </div>
  );
}

function AnswerCard({ answer, compact, mobile }: { answer: AnswerEvent; compact?: boolean; mobile?: boolean }) {
  return (
    <article className={compact || mobile ? "" : "rounded-md border border-slate-800 bg-slate-950 p-3"}>
      {!mobile && (
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500">
          <span>Sensible</span>
          <span>{answer.latencyMs}ms</span>
        </div>
      )}
      <div
        className={`answer-markdown whitespace-pre-wrap ${mobile ? "text-[1.35rem] font-semibold leading-9 text-white" : "text-sm leading-6 text-slate-100"}`}
        dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(answer.answer) }}
      />
    </article>
  );
}

function LoadingAnswer({ mobile }: { mobile?: boolean }) {
  return (
    <div className="space-y-4">
      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
        <div className="meter h-full w-3/4 rounded-full" />
      </div>
      <div className={mobile ? "text-xl font-semibold text-slate-300" : "text-sm text-slate-400"}>Generating answer draft...</div>
    </div>
  );
}

function ToggleCard({
  enabled,
  setEnabled,
  icon,
  title,
  detail,
  status,
  meter,
  badge
}: {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
  status?: string;
  meter?: number;
  badge?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      onClick={() => setEnabled(!enabled)}
      className={`min-h-32 rounded-md border p-3 text-left transition ${
        enabled ? "border-cyan-400/50 bg-slate-900" : "border-slate-800 bg-slate-950 hover:border-slate-600"
      }`}
    >
      <span className="flex items-start gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border ${enabled ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-slate-700 bg-slate-900 text-slate-500"}`}>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-3">
            <span className="block text-sm font-semibold text-slate-100">{title}</span>
            <span className={`shrink-0 rounded-full border px-2 py-1 text-[0.68rem] font-black ${enabled ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-slate-700 bg-slate-800 text-slate-400"}`}>
              {enabled ? "ON" : "OFF"}
            </span>
          </span>
          <span className="mt-1 block text-xs leading-5 text-slate-400">{detail}</span>
          <span className="mt-3 flex items-center justify-between gap-3">
            <span className="truncate text-xs text-slate-500">{status || (enabled ? "Enabled" : "Disabled")}</span>
            {badge && (
              <span className="shrink-0 rounded-full border border-slate-700 px-2 py-1 text-[0.65rem] font-semibold text-slate-400">
                {badge}
              </span>
            )}
          </span>
          {typeof meter === "number" && (
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-slate-800">
              <span
                className="block h-full rounded-full bg-gradient-to-r from-emerald-400 via-cyan-300 to-blue-400 transition-[width]"
                style={{ width: `${Math.round(meter * 100)}%` }}
              />
            </span>
          )}
        </span>
        <span className={`mt-1 h-5 w-9 shrink-0 rounded-full p-0.5 transition ${enabled ? "bg-cyan-400" : "bg-slate-700"}`}>
          <span className={`block h-4 w-4 rounded-full bg-white transition ${enabled ? "translate-x-4" : ""}`} />
        </span>
      </span>
    </button>
  );
}

function StatusBadge({
  active,
  activeLabel,
  inactiveLabel,
  icon
}: {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
  icon: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${
        active ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-slate-700 bg-slate-900 text-slate-400"
      }`}
    >
      {icon}
      {active ? activeLabel : inactiveLabel}
    </span>
  );
}

function ConnectionPill({ connected, compact }: { connected: boolean; compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${
        connected ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-rose-400/40 bg-rose-400/10 text-rose-200"
      }`}
    >
      {connected ? <Wifi size={compact ? 14 : 15} /> : <WifiOff size={compact ? 14 : 15} />}
      {connected ? "Socket Live" : "Offline"}
    </span>
  );
}

function ModelPill({ serverReady }: { serverReady: ServerReady | null }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-300">
      <Bot size={15} />
      {serverReady?.geminiConfigured ? "Sensible Engine" : "Engine not configured"}
    </span>
  );
}

function Logo({ small }: { small?: boolean }) {
  const size = small ? "h-10 w-10" : "h-12 w-12";
  return (
    <div className={`${size} grid shrink-0 place-items-center`}>
      <svg viewBox="0 0 64 64" aria-hidden="true" className={small ? "h-9 w-9" : "h-11 w-11"}>
        <path d="M32 4L55.3827 17.5V44.5L32 58L8.61731 44.5V17.5L32 4Z" fill="#020617" stroke="#2DD4BF" strokeWidth="3" />
        <path d="M34.8 10L19.5 35.1H31.4L28.8 54L44.8 27.9H32.7L34.8 10Z" fill="#2DD4BF" />
      </svg>
    </div>
  );
}

function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-black tracking-normal ${className}`}>
      <span className="text-[#2dd4bf]">Sens</span>
      <span className="text-slate-100">ible</span>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-black text-white">{value}</p>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-slate-800 bg-slate-950/70 p-5 text-center text-slate-500">
      {icon}
      <p className="text-sm">{text}</p>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-rose-400/30 bg-rose-400/10 p-3 text-sm leading-6 text-rose-100">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 shrink-0" size={16} />
        <span>{message}</span>
      </div>
    </div>
  );
}

function WarningBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-sm leading-6 text-amber-100">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 shrink-0" size={16} />
        <span>{message}</span>
      </div>
    </div>
  );
}

function getRealtimeUrl() {
  return import.meta.env.VITE_REALTIME_URL || (import.meta.env.DEV ? "http://localhost:8787" : "");
}

function buildJoinUrl(roomId: string, publicAppUrl?: string) {
  const base = publicAppUrl || window.location.origin;
  const url = new URL(base);
  url.searchParams.set("viewer", "mobile");
  url.searchParams.set("room", roomId);
  return url.toString();
}

function extractQuestion(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const parts = normalized
    .split(/(?<=[?.!])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const candidates = parts.length ? parts : [normalized];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const lower = candidate.toLowerCase();
    const isQuestion = candidate.includes("?") || interrogativeWords.some((word) => lower.startsWith(word) || lower.includes(` ${word} `));
    if (isQuestion && candidate.length >= 8) {
      return candidate.endsWith("?") ? candidate : `${candidate}?`;
    }
  }

  return "";
}

function captureVideoFrame(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  const maxWidth = 1280;
  const ratio = video.videoWidth ? Math.min(1, maxWidth / video.videoWidth) : 1;
  canvas.width = Math.max(320, Math.floor((video.videoWidth || 1280) * ratio));
  canvas.height = Math.max(180, Math.floor((video.videoHeight || 720) * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas context unavailable.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.68);
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Could not read audio chunk."));
    reader.readAsDataURL(blob);
  });
}

function describeCaptureError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError") return "Screen capture permission was denied.";
  if (name === "NotFoundError") return "No screen capture source was available.";
  if (name === "NotReadableError") return "The selected screen could not be captured. Check OS privacy permissions.";
  if (name === "AbortError") return "Screen capture was cancelled.";
  return shortError(error);
}

function shortError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function renderInlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br />");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}

function timeAgo(timestamp: number) {
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function upsertById<T extends { id: string }>(items: T[], limit: number) {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    output.push(item);
  }
  return output.slice(0, limit);
}

function uniqueList(items: string[]) {
  return Array.from(new Set(items)).slice(-6);
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
