// GLB Studio — high-quality capture tool
// React + htm (no transpiler). Chrome-only, desktop-only, Japanese UI.
import React, { useState, useEffect, useRef, useMemo, useCallback, Suspense } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows, Environment, useGLTF } from "@react-three/drei";
import {
  STILL_PRESETS, VIDEO_PRESETS, slug,
  captureStill, makeCameraWork, applyCamState,
  encodeMp4, encodeGif, encodePngSeq, zipBlobs, downloadBlob,
  beginOffscreen, gifDims,
} from "./capture.js";
import {
  PRESETS, defaultLighting, fitToFraction,
  loadAngles, saveAngles, captureAngle, applyAngle,
} from "./presets.js";

const html = htm.bind(React.createElement);

// ---- DRACO wiring ----
// drei's useGLTF wires a DRACOLoader when useDraco is truthy; passing a string
// as useDraco sets the decoder path directly. This makes DRACO-compressed GLBs load.
const DRACO_PATH = "https://www.gstatic.com/draco/versioned/decoders/1.5.6/";

// ---------- utils ----------
const fmtBytes = (n) => {
  if (!n && n !== 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
};
const fmtNum = (n) => (n == null ? "—" : n.toLocaleString("en-US"));

// ---------- Icons ----------
const Icon = ({ name, size = 14 }) => {
  const paths = {
    upload:   "M12 3v12M7 8l5-5 5 5M4 17v3h16v-3",
    play:     "M6 4l14 8-14 8V4z",
    pause:    "M6 4h4v16H6zM14 4h4v16h-4z",
    reset:    "M4 4v6h6M20 20v-6h-6M5 14a8 8 0 0014 4M19 10A8 8 0 005 6",
    download: "M12 4v12M6 10l6 6 6-6M4 20h16",
    close:    "M6 6l12 12M18 6L6 18",
    help:     "M9 9a3 3 0 116 0c0 2-3 2-3 5M12 18v.01",
    grid:     "M4 9h16M4 15h16M9 4v16M15 4v16",
    sun:      "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4",
    box:      "M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4M21 7l-9 4M12 11v10",
    cam:      "M4 7h4l2-3h4l2 3h4v12H4zM12 10a4 4 0 100 8 4 4 0 000-8z",
    video:    "M3 6h13v12H3zM16 10l5-3v10l-5-3z",
    rotate:   "M21 12a9 9 0 11-3-6.7M21 4v5h-5",
    light:    "M9 18h6M10 21h4M12 2a6 6 0 016 6c0 3-2 5-3 7H9c-1-2-3-4-3-7a6 6 0 016-6z",
    file:     "M14 3H6v18h12V7zM14 3v4h4",
    check:    "M5 12l4 4 10-10",
    chev:     "M8 5l8 7-8 7",
    dot:      "M12 12m-4 0a4 4 0 108 0 4 4 0 10-8 0",
    eye:      "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z",
    plus:     "M12 5v14M5 12h14",
    trash:    "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
    save:     "M5 3h11l3 3v15H5zM8 3v6h7V3M8 21v-6h8v6",
    frame:    "M4 4h4M4 4v4M20 4h-4M20 4v4M4 20h4M4 20v-4M20 20h-4M20 20v-4M8 8h8v8H8z",
    layers:   "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
    stop:     "M6 6h12v12H6z",
    cart:     "M4 4h2l2 12h10l2-8H7M9 20a1 1 0 100 2 1 1 0 000-2M17 20a1 1 0 100 2 1 1 0 000-2",
  };
  return html`
    <svg width=${size} height=${size} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <path d=${paths[name] || ""} />
    </svg>`;
};

// ========================================================================
// 3D Scene
// ========================================================================
function Model({ url, onLoaded, autoRotate, axis, dir, speed, groupRef }) {
  const { scene } = useGLTF(url, DRACO_PATH, false);

  const centered = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 2.2 / maxDim;
    scene.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    scene.scale.setScalar(scale);
    let tris = 0, verts = 0;
    scene.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true;
        const g = o.geometry;
        if (g && g.attributes && g.attributes.position) {
          verts += g.attributes.position.count;
          if (g.index) tris += g.index.count / 3;
          else tris += g.attributes.position.count / 3;
        }
      }
    });
    return { scene, verts: Math.round(verts), tris: Math.round(tris), size, maxDim };
  }, [scene]);

  useEffect(() => {
    onLoaded && onLoaded({ verts: centered.verts, tris: centered.tris });
  }, [centered]);

  useFrame((_, delta) => {
    if (!autoRotate || !groupRef.current) return;
    const s = speed * dir;
    if (axis === "x") groupRef.current.rotation.x += s * delta;
    if (axis === "y") groupRef.current.rotation.y += s * delta;
    if (axis === "z") groupRef.current.rotation.z += s * delta;
  });

  return html`<group ref=${groupRef}><primitive object=${centered.scene} /></group>`;
}

function Lights({ L }) {
  const dirToXYZ = (az, el, dist = 6) => {
    const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
    return [Math.cos(e) * Math.sin(a) * dist, Math.sin(e) * dist, Math.cos(e) * Math.cos(a) * dist];
  };
  const key = dirToXYZ(L.key.az, L.key.el);
  const fill = dirToXYZ(L.fill.az, L.fill.el);
  const rim = dirToXYZ(L.rim.az, L.rim.el);
  return html`<${React.Fragment}>
    <ambientLight intensity=${L.ambient.intensity} color=${L.ambient.color} />
    <directionalLight position=${key} intensity=${L.key.intensity} color=${L.key.color}
      castShadow shadow-mapSize-width=${2048} shadow-mapSize-height=${2048} shadow-bias=${-0.0004}
      shadow-camera-left=${-3} shadow-camera-right=${3} shadow-camera-top=${3} shadow-camera-bottom=${-3} />
    <directionalLight position=${fill} intensity=${L.fill.intensity} color=${L.fill.color} />
    <directionalLight position=${rim} intensity=${L.rim.intensity} color=${L.rim.color} />
  <//>`;
}

function CanvasCapture({ onReady, orbitRef }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    onReady && onReady({ gl, scene, camera, controls: orbitRef });
  }, [gl, scene, camera]);
  return null;
}

// Keeps the live viewport clear alpha in sync with the transparent flag
// (Amazon mode / 透過 render transparent so the CSS backdrop shows through).
function ClearColorSync({ transparent }) {
  const { gl, invalidate } = useThree();
  useEffect(() => {
    gl.setClearColor(0x000000, transparent ? 0 : 1);
    invalidate();
  }, [transparent]);
  return null;
}

function Viewport({
  modelUrl, shadow, shadowOpacity, L, auto, axis, dir, speed, envOn, envIntensity,
  onLoaded, onRenderer, camResetKey, transparent, groupRef,
}) {
  const orbitRef = useRef();
  const ResetHandler = () => {
    const { camera } = useThree();
    useEffect(() => {
      camera.position.set(3.2, 2.2, 3.8);
      camera.fov = 35; camera.updateProjectionMatrix();
      camera.lookAt(0, 0, 0);
      if (orbitRef.current) { orbitRef.current.target.set(0, 0, 0); orbitRef.current.update(); }
    }, [camResetKey]);
    return null;
  };

  return html`
    <${Canvas}
      shadows
      gl=${{ preserveDrawingBuffer: true, antialias: true, alpha: true }}
      dpr=${[1, 2]}
      camera=${{ position: [3.2, 2.2, 3.8], fov: 35, near: 0.1, far: 100 }}
      onCreated=${({ gl }) => {
        gl.setClearColor(0x000000, transparent ? 0 : 1);
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.0;
        gl.outputColorSpace = THREE.SRGBColorSpace;
      }}
    >
      <${CanvasCapture} onReady=${onRenderer} orbitRef=${orbitRef} />
      <${ClearColorSync} transparent=${transparent} />
      <${ResetHandler} />
      <${Lights} L=${L} />
      ${envOn && html`<${Suspense} fallback=${null}><${Environment} preset="studio" environmentIntensity=${envIntensity} /><//>`}
      <${Suspense} fallback=${null}>
        ${modelUrl && html`<${Model}
          url=${modelUrl} onLoaded=${onLoaded}
          autoRotate=${auto} axis=${axis} dir=${dir} speed=${speed} groupRef=${groupRef}
        />`}
      <//>
      ${shadow && html`<${ContactShadows} position=${[0, -1.15, 0]} opacity=${shadowOpacity} scale=${8} blur=${2.4} far=${4} />`}
      <${OrbitControls} ref=${orbitRef} enableDamping dampingFactor=${0.08} makeDefault />
    <//>`;
}

// ========================================================================
// UI atoms
// ========================================================================
const Row = ({ label, hint, children, align = "center" }) => html`
  <div style=${{ display: "flex", alignItems: align === "top" ? "flex-start" : "center", justifyContent: "space-between", gap: 12, padding: "8px 0" }}>
    <div style=${{ minWidth: 72 }}>
      <div style=${{ fontSize: 12, color: "var(--ink)" }}>${label}</div>
      ${hint && html`<div class="cap" style=${{ marginTop: 2, fontSize: 10 }}>${hint}</div>`}
    </div>
    <div style=${{ flex: 1, display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>${children}</div>
  </div>`;

const Segment = ({ options, value, onChange, small }) => html`
  <div style=${{ display: "inline-flex", background: "#0b0c0f", border: "1px solid var(--line-2)", borderRadius: 6, padding: 2, gap: 0, flexWrap: "wrap" }}>
    ${options.map((o) => {
      const active = o.value === value;
      return html`<button key=${String(o.value)} onClick=${() => onChange(o.value)}
        style=${{
          padding: small ? "3px 8px" : "4px 10px", fontSize: small ? 11 : 12, borderRadius: 4,
          color: active ? "var(--accent-ink)" : "var(--ink-dim)",
          background: active ? "var(--accent)" : "transparent",
          fontWeight: active ? 600 : 500, transition: "all .12s ease-out",
          display: "inline-flex", alignItems: "center", gap: 5,
        }}>
        ${o.icon && html`<${Icon} name=${o.icon} size=${12} />`}
        ${o.label}
      </button>`;
    })}
  </div>`;

const Btn = ({ onClick, icon, children, kind = "ghost", disabled, style, title }) => {
  const styles = {
    ghost: { background: "transparent", color: "var(--ink-dim)", border: "1px solid var(--line-2)" },
    solid: { background: "var(--elev)", color: "var(--ink)", border: "1px solid var(--line-2)" },
    primary: { background: "var(--accent)", color: "var(--accent-ink)", border: "1px solid transparent", fontWeight: 600 },
    amazon: { background: "var(--amazon)", color: "#1a1300", border: "1px solid transparent", fontWeight: 600 },
    danger: { background: "transparent", color: "#ff8b8b", border: "1px solid rgba(255,139,139,0.3)" },
  };
  return html`<button onClick=${onClick} disabled=${disabled} title=${title}
    onMouseEnter=${(e) => { if (!disabled) e.currentTarget.style.borderColor = "var(--accent)"; }}
    onMouseLeave=${(e) => { e.currentTarget.style.borderColor = styles[kind].border.split(" ")[2] || "var(--line-2)"; }}
    style=${{
      padding: "7px 11px", borderRadius: 6, fontSize: 12, fontFamily: "inherit",
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
      opacity: disabled ? 0.4 : 1, cursor: disabled ? "not-allowed" : "pointer",
      transition: "all .12s ease-out", ...styles[kind], ...style,
    }}>
    ${icon && html`<${Icon} name=${icon} size=${13} />`}
    ${children}
  </button>`;
};

const Slider = ({ value, min, max, step, onChange, unit = "", width = 120, format }) => html`
  <div style=${{ display: "flex", alignItems: "center", gap: 8, flex: 1, justifyContent: "flex-end" }}>
    <input type="range" min=${min} max=${max} step=${step} value=${value}
      onInput=${(e) => onChange(parseFloat(e.target.value))} style=${{ flex: 1, maxWidth: width }} />
    <div class="mono" style=${{ minWidth: 46, textAlign: "right", fontSize: 11, color: "var(--ink-dim)" }}>
      ${format ? format(value) : value.toFixed(step < 1 ? 2 : 0) + unit}
    </div>
  </div>`;

const ColorDot = ({ value, onChange }) => html`
  <label style=${{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
    <input type="color" value=${value} onInput=${(e) => onChange(e.target.value)} />
    <span class="mono" style=${{ fontSize: 10.5, color: "var(--ink-mute)", textTransform: "uppercase" }}>${value}</span>
  </label>`;

const PanelHeader = ({ icon, label, right }) => html`
  <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
    <div style=${{ display: "flex", alignItems: "center", gap: 8 }}>
      ${icon && html`<div style=${{ color: "var(--ink-dim)" }}><${Icon} name=${icon} size=${13} /></div>`}
      <div style=${{ fontSize: 12.5, fontWeight: 600, letterSpacing: "0.01em" }}>${label}</div>
    </div>
    ${right}
  </div>`;

const SubHeader = ({ children, right }) => html`
  <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0 6px" }}>
    <div class="cap">${children}</div>
    ${right}
  </div>`;

// ---------- hemisphere widget ----------
const HemiWidget = ({ az, el, onChange, size = 74 }) => {
  const ref = useRef();
  const dragging = useRef(false);
  const pos = useMemo(() => {
    const r = (90 - el) / 90;
    const a = (az * Math.PI) / 180;
    return [(size / 2) + Math.sin(a) * (size / 2 - 4) * r, (size / 2) - Math.cos(a) * (size / 2 - 4) * r];
  }, [az, el, size]);
  const handle = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) - size / 2;
    const y = (e.clientY - rect.top) - size / 2;
    const r = Math.min(1, Math.hypot(x, y) / (size / 2 - 4));
    onChange(Math.round((Math.atan2(x, -y) * 180) / Math.PI), Math.round(90 - r * 90));
  };
  return html`
    <svg ref=${ref} width=${size} height=${size}
      onPointerDown=${(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); handle(e); }}
      onPointerMove=${(e) => { if (dragging.current) handle(e); }}
      onPointerUp=${() => { dragging.current = false; }}
      style=${{ cursor: "grab", userSelect: "none", touchAction: "none" }}>
      <circle cx=${size / 2} cy=${size / 2} r=${size / 2 - 2} fill="#0b0c0f" stroke="var(--line-2)" />
      <circle cx=${size / 2} cy=${size / 2} r=${(size / 2 - 2) * 0.66} fill="none" stroke="var(--line)" stroke-dasharray="2 3" />
      <circle cx=${size / 2} cy=${size / 2} r=${(size / 2 - 2) * 0.33} fill="none" stroke="var(--line)" stroke-dasharray="2 3" />
      <line x1=${2} y1=${size / 2} x2=${size - 2} y2=${size / 2} stroke="var(--line)" />
      <line x1=${size / 2} y1=${2} x2=${size / 2} y2=${size - 2} stroke="var(--line)" />
      <circle cx=${pos[0]} cy=${pos[1]} r=${5} fill="var(--accent)" stroke="#061014" stroke-width="1.5" />
    </svg>`;
};

const LightBlock = ({ label, data, onChange, showDir = true }) => html`
  <div style=${{ background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
    <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
      <div style=${{ fontSize: 12, fontWeight: 600 }}>${label}</div>
      <${ColorDot} value=${data.color} onChange=${(v) => onChange({ ...data, color: v })} />
    </div>
    <${Row} label="光量">
      <${Slider} value=${data.intensity} min=${0} max=${3} step=${0.05}
        onChange=${(v) => onChange({ ...data, intensity: v })} format=${(v) => v.toFixed(2)} width=${140} />
    <//>
    ${showDir && html`
      <div style=${{ display: "flex", gap: 12, alignItems: "center", marginTop: 4 }}>
        <${HemiWidget} az=${data.az} el=${data.el} onChange=${(az, el) => onChange({ ...data, az, el })} size=${74} />
        <div style=${{ flex: 1 }}>
          <${Row} label="方位" hint="AZ">
            <${Slider} value=${data.az} min=${-180} max=${180} step=${1} onChange=${(v) => onChange({ ...data, az: v })} unit="°" width=${90} />
          <//>
          <${Row} label="仰角" hint="EL">
            <${Slider} value=${data.el} min=${0} max=${90} step=${1} onChange=${(v) => onChange({ ...data, el: v })} unit="°" width=${90} />
          <//>
        </div>
      </div>`}
  </div>`;

// ========================================================================
// Main App
// ========================================================================
function App() {
  // model
  const [modelUrl, setModelUrl] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  // viewport
  const [bgMode, setBgMode] = useState("solid"); // solid | grad | alpha
  const [shadow, setShadow] = useState(true);

  // amazon mode
  const [amazon, setAmazon] = useState(false);

  // rotation (object spin)
  const [mode, setMode] = useState("manual");
  const [axis, setAxis] = useState("y");
  const [dir, setDir] = useState(1);
  const [speed, setSpeed] = useState(0.6);
  const [playing, setPlaying] = useState(true);
  const [camResetKey, setCamResetKey] = useState(0);

  // lighting
  const [L, setL] = useState(defaultLighting);
  const [activePreset, setActivePreset] = useState("スタジオ");
  const [envOn, setEnvOn] = useState(false);
  const [envIntensity, setEnvIntensity] = useState(0.6);

  // tabs
  const [tab, setTab] = useState("angles");

  // still export
  const [stillPreset, setStillPreset] = useState(0);
  const [customW, setCustomW] = useState(2000);
  const [customH, setCustomH] = useState(2000);
  const [useCustom, setUseCustom] = useState(false);
  const [imgFormat, setImgFormat] = useState("png"); // png | png-alpha | jpg

  // angles
  const [angles, setAngles] = useState(() => loadAngles());
  const [angleName, setAngleName] = useState("");
  const [selectedAngles, setSelectedAngles] = useState(() => new Set());

  // video
  const [videoPreset, setVideoPreset] = useState(1);
  const [vCustomW, setVCustomW] = useState(1080);
  const [vCustomH, setVCustomH] = useState(1080);
  const [vUseCustom, setVUseCustom] = useState(false);
  const [videoFormat, setVideoFormat] = useState("mp4"); // mp4 | gif | png
  const [camWork, setCamWork] = useState("turntable"); // turntable | orbit | dolly | spin
  const [orbitDeg, setOrbitDeg] = useState(30);
  const [videoFps, setVideoFps] = useState(30);
  const [videoDur, setVideoDur] = useState("1rot");
  const [videoSecs, setVideoSecs] = useState(4);

  // job status
  const [job, setJob] = useState(null); // { label, progress, cancel }
  const [lastCapture, setLastCapture] = useState(null);
  const [toast, setToast] = useState(null);

  const rendererRef = useRef(null);
  const groupRef = useRef();
  const [helpOpen, setHelpOpen] = useState(false);

  const transparent = bgMode === "alpha";

  // amazon mode side-effects: force soft lighting + shadow on, non-alpha bg
  useEffect(() => {
    if (amazon) {
      setActivePreset("ソフト");
      setL(JSON.parse(JSON.stringify(PRESETS["ソフト"])));
      setShadow(true);
      setBgMode("solid");
      setImgFormat("jpg");
      if (useCustom ? Math.max(customW, customH) < 1600 : false) setUseCustom(false);
      // default resolution 2000x2000
      setUseCustom(false);
      setStillPreset(1);
      setTab("angles");
    }
  }, [amazon]);

  const showToast = (msg, tone = "ok") => { setToast({ msg, tone }); setTimeout(() => setToast(null), 3200); };

  // --- file handling ---
  const loadFile = useCallback((file) => {
    if (!file) return;
    if (!/\.(glb|gltf)$/i.test(file.name)) { setLoadErr("GLB / GLTF ファイルを選択してください"); return; }
    setLoadErr(null); setLoading(true);
    const url = URL.createObjectURL(file);
    setFileInfo({ name: file.name, size: file.size, verts: null, tris: null });
    setModelUrl(url);
  }, []);

  const onModelLoaded = useCallback(({ verts, tris }) => {
    setFileInfo((fi) => (fi ? { ...fi, verts, tris } : fi));
    setLoading(false);
  }, []);

  useEffect(() => () => { if (modelUrl) URL.revokeObjectURL(modelUrl); }, [modelUrl]);

  // --- preset apply ---
  const applyPreset = (name) => { setActivePreset(name); setL(JSON.parse(JSON.stringify(PRESETS[name]))); };
  const updateL = (k, v) => { setL({ ...L, [k]: v }); setActivePreset(null); };

  // ---- resolution resolver ----
  const stillSize = () => {
    if (useCustom) return { w: Math.max(1, Math.round(customW)), h: Math.max(1, Math.round(customH)) };
    return { w: STILL_PRESETS[stillPreset].w, h: STILL_PRESETS[stillPreset].h };
  };
  const videoSize = () => {
    if (vUseCustom) return { w: Math.max(2, Math.round(vCustomW)), h: Math.max(2, Math.round(vCustomH)) };
    return { w: VIDEO_PRESETS[videoPreset].w, h: VIDEO_PRESETS[videoPreset].h };
  };

  // amazon: enforce long edge >= 1600
  const stillTooSmall = () => {
    const { w, h } = stillSize();
    return amazon && Math.max(w, h) < 1600;
  };

  // ---- angle ops ----
  const persistAngles = (next) => { setAngles(next); saveAngles(next); };
  const doSaveAngle = () => {
    const r = rendererRef.current;
    if (!r) return;
    const a = captureAngle(angleName.trim() || `アングル ${angles.length + 1}`, r.camera, r.controls.current);
    persistAngles([...angles, a]);
    setAngleName("");
    showToast("アングルを保存しました");
  };
  const doApplyAngle = (a) => {
    const r = rendererRef.current;
    if (!r) return;
    applyAngle(a, r.camera, r.controls.current);
  };
  const doDeleteAngle = (id) => {
    persistAngles(angles.filter((a) => a.id !== id));
    setSelectedAngles((s) => { const n = new Set(s); n.delete(id); return n; });
  };
  const toggleSelect = (id) => setSelectedAngles((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const exportAnglesJson = () => {
    downloadBlob(new Blob([JSON.stringify(angles, null, 2)], { type: "application/json" }), "glbstudio_angles.json");
  };
  const importAnglesJson = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const arr = JSON.parse(rd.result);
        if (Array.isArray(arr)) { persistAngles(arr); showToast(`${arr.length} 件のアングルを読み込みました`); }
      } catch { showToast("JSON の読み込みに失敗しました", "warn"); }
    };
    rd.readAsText(file);
  };

  // ---- framing (85% fit) ----
  const doFit = () => {
    const r = rendererRef.current;
    if (!r || !groupRef.current) return;
    const { w, h } = amazon ? stillSize() : { w: 1, h: 1 };
    fitToFraction(groupRef.current, r.camera, r.controls.current, { fraction: 0.85, aspect: amazon ? w / h : r.camera.aspect });
    r.gl.render(r.scene, r.camera);
  };

  // ---- single still export ----
  const doExportStill = async () => {
    const r = rendererRef.current;
    if (!r) return;
    if (stillTooSmall()) { showToast("Amazonモードは長辺1600px以上が必要です", "warn"); return; }
    const { w, h } = stillSize();
    const fmt = amazon ? "jpg" : imgFormat;
    try {
      const res = await captureStill(r.gl, r.scene, r.camera, { w, h, format: fmt, amazon });
      if (amazon && res.whiteCheck && !res.whiteCheck.ok) {
        showToast("警告: 四隅が純白になっていません", "warn");
      }
      const url = URL.createObjectURL(res.blob);
      const name = `${slug(fileInfo?.name)}_${w}x${h}.${res.ext}`;
      setLastCapture({ type: "image", url, name, w, h, blob: res.blob, note: amazon ? "白背景検証: " + (res.whiteCheck?.ok ? "純白OK" : "NG") : null });
      showToast("静止画を書き出しました");
    } catch (e) { showToast("書き出しエラー: " + e.message, "warn"); }
  };

  // ---- batch still ZIP over selected angles ----
  const doBatchStill = async () => {
    const r = rendererRef.current;
    if (!r) return;
    if (stillTooSmall()) { showToast("Amazonモードは長辺1600px以上が必要です", "warn"); return; }
    const sel = angles.filter((a) => selectedAngles.has(a.id));
    if (!sel.length) { showToast("アングルを選択してください", "warn"); return; }
    const { w, h } = stillSize();
    const fmt = amazon ? "jpg" : imgFormat;
    const ctrl = new AbortController();
    setJob({ label: "一括書き出し", progress: 0, cancel: () => ctrl.abort() });
    const entries = [];
    let whiteFails = 0;
    try {
      for (let i = 0; i < sel.length; i++) {
        if (ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");
        applyAngle(sel[i], r.camera, r.controls.current);
        if (amazon) fitToFraction(groupRef.current, r.camera, r.controls.current, { fraction: 0.85, aspect: w / h });
        const res = await captureStill(r.gl, r.scene, r.camera, { w, h, format: fmt, amazon });
        if (amazon && res.whiteCheck && !res.whiteCheck.ok) whiteFails++;
        entries.push({ name: `${slug(fileInfo?.name)}_${slug(sel[i].name)}_${w}x${h}.${res.ext}`, blob: res.blob });
        setJob((j) => ({ ...j, progress: (i + 1) / sel.length }));
        await new Promise((res2) => setTimeout(res2, 0));
      }
      const zip = await zipBlobs(entries);
      downloadBlob(zip, `${slug(fileInfo?.name)}_angles_${w}x${h}.zip`);
      showToast(`${entries.length}枚をZIPで書き出しました` + (whiteFails ? ` (白検証NG: ${whiteFails})` : ""));
    } catch (e) {
      if (e.name !== "AbortError") showToast("一括書き出しエラー: " + e.message, "warn");
    } finally { setJob(null); }
  };

  // ---- deterministic video/animation export ----
  const doExportVideo = async () => {
    const r = rendererRef.current;
    if (!r || !groupRef.current) return;
    const { gl, scene, camera, controls } = r;
    let { w, h } = videoSize();
    // avc1 requires even dimensions; enforce so buffer and encoder config agree.
    if (videoFormat === "mp4") { w -= w % 2; h -= h % 2; }
    // GIF renders directly at its reduced size to keep per-frame quantize cheap.
    const gd = videoFormat === "gif" ? gifDims(w, h) : null;
    const renderW = gd ? gd.w : w;
    const renderH = gd ? gd.h : h;
    const fps = videoFps;
    // "1周" = one full revolution over 4s by default; "秒数指定" = user seconds.
    // Frame count is deterministic (fps × seconds), independent of wall-clock speed.
    const durSecs = videoDur === "1rot" ? 4 : Math.max(1, videoSecs);
    const frames = Math.max(2, Math.round(durSecs * fps));

    // capture base camera state for camera-work drivers
    const baseState = {
      pos: camera.position.toArray(),
      target: controls.current ? controls.current.target.toArray() : [0, 0, 0],
    };
    const baseRotY = groupRef.current.rotation.y;
    const driver = camWork === "spin" ? null : makeCameraWork(camWork, baseState, { deg: orbitDeg, dir });

    const ctrl = new AbortController();

    // Size the renderer ONCE for the whole clip (per-frame resize is very slow).
    const session = beginOffscreen(gl, scene, camera, renderW, renderH, { transparent: !!amazon });
    // A reusable 2D canvas holds each finished frame so the next render doesn't
    // clobber the pixels the encoder still needs.
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = renderW; frameCanvas.height = renderH;
    const fctx = frameCanvas.getContext("2d", { willReadFrequently: videoFormat !== "mp4" });

    // drawFrame(i) -> returns a full-size canvas with the rendered frame.
    // (Encoders downscale as needed; GIF/PNG pass their own target dims which we ignore here.)
    const drawFrame = async (i) => {
      const t = i / frames; // 0..1
      if (camWork === "spin") {
        groupRef.current.rotation.y = baseRotY + t * Math.PI * 2 * dir;
        applyCamState(camera, controls.current, { pos: new THREE.Vector3(...baseState.pos), target: new THREE.Vector3(...baseState.target) });
      } else {
        applyCamState(camera, controls.current, driver(t));
      }
      const src = session.renderFrame();
      if (amazon) {
        fctx.fillStyle = "#ffffff"; fctx.fillRect(0, 0, renderW, renderH);
      } else {
        fctx.clearRect(0, 0, renderW, renderH);
      }
      fctx.drawImage(src, 0, 0, renderW, renderH);
      return frameCanvas;
    };

    setJob({ label: videoFormat === "mp4" ? "MP4 書き出し" : videoFormat === "gif" ? "GIF 書き出し" : "連番PNG 書き出し", progress: 0, cancel: () => ctrl.abort() });
    const onProgress = (p) => setJob((j) => (j ? { ...j, progress: p } : j));
    try {
      let blob, name, note = null, ow = w, oh = h;
      if (videoFormat === "mp4") {
        blob = await encodeMp4({ w, h, fps, totalFrames: frames, drawFrame, onProgress, signal: ctrl.signal });
        name = `${slug(fileInfo?.name)}_${camWork}_${w}x${h}.mp4`;
      } else if (videoFormat === "gif") {
        const res = await encodeGif({ gw: renderW, gh: renderH, fps, totalFrames: frames, drawFrame, onProgress, signal: ctrl.signal });
        blob = res.blob; ow = res.w; oh = res.h;
        name = `${slug(fileInfo?.name)}_${camWork}_${ow}x${oh}.gif`;
        note = "GIFは長辺500px・15fpsに制限";
      } else {
        blob = await encodePngSeq({ w, h, totalFrames: frames, baseName: `${slug(fileInfo?.name)}_${camWork}`, drawFrame, onProgress, signal: ctrl.signal });
        name = `${slug(fileInfo?.name)}_${camWork}_${w}x${h}_png.zip`;
      }
      const url = URL.createObjectURL(blob);
      setLastCapture({ type: videoFormat === "mp4" ? "video" : videoFormat === "gif" ? "image" : "file", url, name, w: ow, h: oh, blob, note });
      showToast("書き出しが完了しました (" + (blob.size / 1024 / 1024).toFixed(2) + " MB)");
    } catch (e) {
      if (e.name !== "AbortError") showToast("動画書き出しエラー: " + e.message, "warn");
      else showToast("書き出しをキャンセルしました", "warn");
    } finally {
      // restore renderer/camera/scene state exactly once
      groupRef.current.rotation.y = baseRotY;
      applyCamState(camera, controls.current, { pos: new THREE.Vector3(...baseState.pos), target: new THREE.Vector3(...baseState.target) });
      session.end();
      setJob(null);
    }
  };

  // ---------- render ----------
  const bgClass = amazon ? "whitebg" : bgMode === "alpha" ? "checker" : bgMode === "grad" ? "gradbg" : "solidbg";
  // In Amazon mode the canvas renders transparent so the white div shows through
  // (matching the exported white-composite), while contact shadow stays on.
  const viewTransparent = transparent || amazon;

  return html`
    <div style=${{ display: "grid", gridTemplateColumns: "280px 1fr 356px", gridTemplateRows: "52px 1fr", height: "100%" }}>

      <!-- TOP BAR -->
      <div style=${{ gridColumn: "1 / 4", gridRow: "1", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", borderBottom: "1px solid var(--line)", background: "var(--panel)" }}>
        <div style=${{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style=${{ width: 24, height: 24, borderRadius: 6, background: "linear-gradient(135deg, var(--accent), oklch(0.78 0.11 260))", display: "grid", placeItems: "center", color: "var(--accent-ink)" }}>
            <${Icon} name="box" size=${14} />
          </div>
          <div style=${{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div style=${{ fontSize: 13.5, fontWeight: 700, letterSpacing: "0.01em" }}>GLB Studio</div>
            <div class="cap">高品質キャプチャ</div>
          </div>
        </div>
        <div style=${{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick=${() => setAmazon(!amazon)} title="Amazon商品画像モード"
            style=${{
              display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 6, fontSize: 12,
              border: `1px solid ${amazon ? "var(--amazon)" : "var(--line-2)"}`,
              background: amazon ? "var(--amazon-dim)" : "transparent",
              color: amazon ? "var(--amazon)" : "var(--ink-dim)", fontWeight: amazon ? 600 : 500, transition: "all .12s",
            }}>
            <${Icon} name="cart" size=${13} /> Amazon商品画像 ${amazon ? "ON" : "OFF"}
          </button>
          <${Btn} icon="reset" onClick=${() => setCamResetKey((k) => k + 1)}>視点リセット<//>
          <${Btn} icon="help" onClick=${() => setHelpOpen(true)} title="ヘルプ">ヘルプ<//>
        </div>
      </div>

      <!-- LEFT SIDEBAR -->
      <aside style=${{ gridColumn: "1", gridRow: "2", background: "var(--panel)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <${PanelHeader} icon="upload" label="アップロード" />
        <div style=${{ padding: "12px 14px", overflow: "auto" }}>
          <label
            onDragOver=${(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave=${() => setDragOver(false)}
            onDrop=${(e) => { e.preventDefault(); setDragOver(false); loadFile(e.dataTransfer.files[0]); }}
            style=${{ display: "block", border: `1.5px dashed ${dragOver ? "var(--accent)" : "var(--line-2)"}`, borderRadius: 10, padding: "22px 14px", textAlign: "center", background: dragOver ? "var(--accent-dim)" : "#0b0c0f", transition: "all .15s ease-out", cursor: "pointer" }}>
            <input type="file" accept=".glb,.gltf" style=${{ display: "none" }} onChange=${(e) => loadFile(e.target.files[0])} />
            <div style=${{ color: "var(--ink-dim)", marginBottom: 8 }}><${Icon} name="upload" size=${20} /></div>
            <div style=${{ fontSize: 12.5, color: "var(--ink)", marginBottom: 4 }}>ここにGLBファイルをドラッグ</div>
            <div class="cap" style=${{ marginBottom: 10 }}>.glb / .gltf (DRACO対応)</div>
            <div style=${{ display: "inline-block", padding: "6px 12px", borderRadius: 6, background: "var(--elev)", border: "1px solid var(--line-2)", fontSize: 11.5, color: "var(--ink)" }}>ファイルを選択</div>
          </label>
          ${loadErr && html`<div style=${{ marginTop: 8, fontSize: 11.5, color: "#ff8b8b" }}>${loadErr}</div>`}

          <div style=${{ marginTop: 14 }}>
            <${SubHeader}>ファイル情報<//>
            <div style=${{ background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", fontSize: 12 }}>
              <div style=${{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink)" }}>
                <${Icon} name="file" size=${12} />
                <div style=${{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${fileInfo?.name || "未選択"}</div>
              </div>
              <div style=${{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
                <${Metric} k="ファイルサイズ" v=${fmtBytes(fileInfo?.size)} />
                <${Metric} k="頂点数" v=${fmtNum(fileInfo?.verts)} />
                <${Metric} k="三角形" v=${fmtNum(fileInfo?.tris)} />
                <${Metric} k="状態" v=${loading ? "読込中…" : modelUrl ? "準備完了" : "—"} tone=${loading ? "warn" : modelUrl ? "ok" : "mute"} />
              </div>
            </div>
          </div>

          <div style=${{ marginTop: 14, opacity: amazon ? 0.4 : 1, pointerEvents: amazon ? "none" : "auto" }}>
            <${SubHeader}>表示背景<//>
            <${Segment} value=${bgMode} onChange=${setBgMode} options=${[
              { value: "solid", label: "単色" }, { value: "grad", label: "グラデ" }, { value: "alpha", label: "透過" },
            ]} />
            ${amazon && html`<div class="cap" style=${{ marginTop: 6, fontSize: 9.5, textTransform: "none", letterSpacing: 0, color: "var(--amazon)" }}>Amazonモード中は純白固定</div>`}
          </div>

          <div style=${{ marginTop: 12 }}>
            <${SubHeader}>グラウンド<//>
            <label style=${{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked=${shadow} onChange=${(e) => setShadow(e.target.checked)} />
              <span style=${{ fontSize: 12 }}>接地シャドウを表示</span>
            </label>
          </div>

          <div style=${{ marginTop: 14 }}>
            <${SubHeader}>操作<//>
            <div style=${{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.7 }}>
              <div><span class="kbd">ドラッグ</span> 回転</div>
              <div><span class="kbd">右ドラッグ</span> パン</div>
              <div><span class="kbd">ホイール</span> ズーム</div>
            </div>
          </div>
        </div>
      </aside>

      <!-- CENTER VIEWPORT -->
      <main style=${{ gridColumn: "2", gridRow: "2", position: "relative", overflow: "hidden" }} class=${bgClass}>
        <${Viewport}
          modelUrl=${modelUrl}
          shadow=${(amazon || shadow) && !transparent}
          shadowOpacity=${amazon ? 0.28 : 0.55}
          L=${L}
          auto=${mode === "auto" && playing}
          axis=${axis} dir=${dir} speed=${speed}
          envOn=${envOn} envIntensity=${envIntensity}
          onLoaded=${onModelLoaded}
          onRenderer=${(r) => { rendererRef.current = r; window.__glbstudio = { ...r, modelGroup: groupRef }; /* debug hook */ }}
          camResetKey=${camResetKey}
          transparent=${viewTransparent}
          groupRef=${groupRef}
        />

        ${!modelUrl && html`<${EmptyState} />`}

        ${loading && html`
          <div style=${{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", animation: "fadein .2s ease-out" }}>
            <div style=${{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: "rgba(14,15,18,0.8)", border: "1px solid var(--line-2)", borderRadius: 999, backdropFilter: "blur(8px)" }}>
              <div style=${{ width: 14, height: 14, borderRadius: 999, border: "2px solid var(--line-2)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }} />
              <span style=${{ fontSize: 12, color: amazon ? "#333" : "inherit" }}>モデルを解析中…</span>
            </div>
          </div>`}

        <div style=${{ position: "absolute", bottom: 10, left: 12, display: "flex", gap: 6 }}>
          ${amazon && html`<${ViewportChip} label="AMAZON 純白" amber />`}
          ${fileInfo?.name && html`<${ViewportChip} label=${fileInfo.name} />`}
        </div>
        <div style=${{ position: "absolute", bottom: 10, right: 12, display: "flex", gap: 6 }}>
          <${ViewportChip} label=${mode === "auto" && playing ? `● 自動回転 ${axis.toUpperCase()}` : "◌ 手動"} live=${mode === "auto" && playing} />
        </div>

        ${job && html`<${JobOverlay} job=${job} />`}
      </main>

      <!-- RIGHT PANEL -->
      <aside style=${{ gridColumn: "3", gridRow: "2", background: "var(--panel)", borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style=${{ display: "flex", borderBottom: "1px solid var(--line)" }}>
          ${[
            { id: "angles", label: "アングル", icon: "cam" },
            { id: "still", label: "静止画", icon: "download" },
            { id: "motion", label: "モーション", icon: "video" },
            { id: "light", label: "光", icon: "light" },
          ].map((t) => {
            const active = tab === t.id;
            return html`<button key=${t.id} onClick=${() => setTab(t.id)}
              style=${{ flex: 1, padding: "12px 6px", fontSize: 11.5, color: active ? "var(--ink)" : "var(--ink-mute)", fontWeight: active ? 600 : 500, borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent", background: active ? "var(--panel-2)" : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, transition: "all .12s ease-out" }}>
              <${Icon} name=${t.icon} size=${13} /> ${t.label}
            </button>`;
          })}
        </div>

        <div style=${{ overflow: "auto", padding: "10px 14px 24px" }}>
          ${tab === "angles" && html`<${AnglesTab}
            angles=${angles} angleName=${angleName} setAngleName=${setAngleName}
            selected=${selectedAngles} toggleSelect=${toggleSelect}
            onSave=${doSaveAngle} onApply=${doApplyAngle} onDelete=${doDeleteAngle}
            onExport=${exportAnglesJson} onImport=${importAnglesJson}
            modelReady=${!!modelUrl && !loading} amazon=${amazon} onFit=${doFit}
            onSelectAll=${() => setSelectedAngles(new Set(angles.map((a) => a.id)))}
            onSelectNone=${() => setSelectedAngles(new Set())}
          />`}
          ${tab === "still" && html`<${StillTab}
            stillPreset=${stillPreset} setStillPreset=${setStillPreset}
            useCustom=${useCustom} setUseCustom=${setUseCustom}
            customW=${customW} setCustomW=${setCustomW} customH=${customH} setCustomH=${setCustomH}
            imgFormat=${imgFormat} setImgFormat=${setImgFormat}
            amazon=${amazon} stillTooSmall=${stillTooSmall()}
            modelReady=${!!modelUrl && !loading}
            selectedCount=${selectedAngles.size}
            onExport=${doExportStill} onBatch=${doBatchStill} onFit=${doFit}
          />`}
          ${tab === "motion" && html`<${MotionTab}
            videoPreset=${videoPreset} setVideoPreset=${setVideoPreset}
            vUseCustom=${vUseCustom} setVUseCustom=${setVUseCustom}
            vCustomW=${vCustomW} setVCustomW=${setVCustomW} vCustomH=${vCustomH} setVCustomH=${setVCustomH}
            videoFormat=${videoFormat} setVideoFormat=${setVideoFormat}
            camWork=${camWork} setCamWork=${setCamWork} orbitDeg=${orbitDeg} setOrbitDeg=${setOrbitDeg}
            videoFps=${videoFps} setVideoFps=${setVideoFps}
            videoDur=${videoDur} setVideoDur=${setVideoDur} videoSecs=${videoSecs} setVideoSecs=${setVideoSecs}
            spinSpeed=${speed} setSpinSpeed=${setSpeed} spinDir=${dir} setSpinDir=${setDir}
            mode=${mode} setMode=${setMode} playing=${playing} setPlaying=${setPlaying}
            axis=${axis} setAxis=${setAxis}
            modelReady=${!!modelUrl && !loading} onExport=${doExportVideo}
          />`}
          ${tab === "light" && html`<${LightTab}
            L=${L} updateL=${updateL} activePreset=${activePreset} applyPreset=${applyPreset}
            envOn=${envOn} setEnvOn=${setEnvOn} envIntensity=${envIntensity} setEnvIntensity=${setEnvIntensity}
            amazon=${amazon}
          />`}

          ${lastCapture && html`<${CapturePreview} cap=${lastCapture} onClear=${() => setLastCapture(null)} />`}
        </div>
      </aside>

      ${toast && html`<${Toast} toast=${toast} />`}
      ${helpOpen && html`<${HelpModal} onClose=${() => setHelpOpen(false)} />`}
    </div>`;
}

// ========================================================================
// subcomponents
// ========================================================================
const Metric = ({ k, v, tone }) => {
  const color = tone === "warn" ? "var(--warn)" : tone === "ok" ? "var(--ok)" : tone === "mute" ? "var(--ink-mute)" : "var(--ink)";
  return html`<div>
    <div class="cap" style=${{ fontSize: 10 }}>${k}</div>
    <div class="mono" style=${{ fontSize: 12, color, marginTop: 2 }}>${v}</div>
  </div>`;
};

const ViewportChip = ({ label, live, amber }) => html`
  <div style=${{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999, background: amber ? "rgba(255,255,255,0.85)" : "rgba(14,15,18,0.6)", backdropFilter: "blur(8px)", border: `1px solid ${amber ? "var(--amazon)" : "var(--line-2)"}`, fontSize: 10.5, color: amber ? "#7a5800" : "var(--ink-dim)", fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.02em", animation: live ? "pulse 2.5s ease-in-out infinite" : "none" }}>${label}</div>`;

const EmptyState = () => html`
  <div style=${{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", color: "var(--ink-mute)", textAlign: "center" }}>
    <div>
      <div style=${{ width: 72, height: 72, borderRadius: 14, margin: "0 auto 14px", border: "1.5px dashed var(--line-2)", display: "grid", placeItems: "center", color: "var(--ink-mute)" }}>
        <${Icon} name="box" size=${28} />
      </div>
      <div style=${{ fontSize: 13, color: "var(--ink-dim)" }}>モデルが読み込まれていません</div>
      <div class="cap" style=${{ marginTop: 6 }}>左からGLBをアップロード</div>
    </div>
  </div>`;

const JobOverlay = ({ job }) => html`
  <div style=${{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(8,9,11,0.55)", backdropFilter: "blur(3px)", animation: "fadein .15s ease-out", zIndex: 5 }}>
    <div style=${{ width: 300, padding: "18px 20px", borderRadius: 12, background: "var(--panel)", border: "1px solid var(--line-2)", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
      <div style=${{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style=${{ width: 8, height: 8, borderRadius: 999, background: "var(--accent)", animation: "pulse 1s ease-in-out infinite" }} />
        <div style=${{ fontSize: 12.5, fontWeight: 600 }}>${job.label}</div>
        <div class="mono" style=${{ marginLeft: "auto", fontSize: 12, color: "var(--accent)" }}>${Math.round(job.progress * 100)}%</div>
      </div>
      <div style=${{ height: 4, background: "var(--line-2)", borderRadius: 2, overflow: "hidden" }}>
        <div style=${{ width: `${job.progress * 100}%`, height: "100%", background: "var(--accent)", transition: "width .12s linear" }} />
      </div>
      <div style=${{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
        <${Btn} kind="danger" icon="stop" onClick=${job.cancel}>キャンセル<//>
      </div>
    </div>
  </div>`;

const Toast = ({ toast }) => html`
  <div style=${{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 60, padding: "10px 16px", borderRadius: 999, background: "var(--panel)", border: `1px solid ${toast.tone === "warn" ? "var(--warn)" : "var(--accent)"}`, boxShadow: "0 12px 40px rgba(0,0,0,0.5)", display: "flex", alignItems: "center", gap: 8, animation: "fadein .18s ease-out" }}>
    <div style=${{ color: toast.tone === "warn" ? "var(--warn)" : "var(--accent)" }}><${Icon} name=${toast.tone === "warn" ? "help" : "check"} size=${13} /></div>
    <span style=${{ fontSize: 12.5 }}>${toast.msg}</span>
  </div>`;

// ---------- Angles tab ----------
const AnglesTab = ({ angles, angleName, setAngleName, selected, toggleSelect, onSave, onApply, onDelete, onExport, onImport, modelReady, amazon, onFit, onSelectAll, onSelectNone }) => html`
  <${SubHeader}>現在の視点を保存<//>
  <div style=${{ display: "flex", gap: 6 }}>
    <input class="wide" type="text" placeholder="アングル名 (例: 正面)" value=${angleName}
      onInput=${(e) => setAngleName(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && modelReady) onSave(); }} />
    <${Btn} kind="primary" icon="save" disabled=${!modelReady} onClick=${onSave}>保存<//>
  </div>

  ${amazon && html`
    <div style=${{ marginTop: 10 }}>
      <${Btn} kind="amazon" icon="frame" disabled=${!modelReady} onClick=${onFit} style=${{ width: "100%" }}>長辺を画面の85%にフィット<//>
    </div>`}

  <${SubHeader} right=${angles.length ? html`<div style=${{ display: "flex", gap: 8 }}>
      <button class="cap" style=${{ color: "var(--ink-dim)" }} onClick=${onSelectAll}>全選択</button>
      <button class="cap" style=${{ color: "var(--ink-dim)" }} onClick=${onSelectNone}>解除</button>
    </div>` : null}>保存済みアングル (${angles.length})<//>

  ${!angles.length && html`<div style=${{ fontSize: 11.5, color: "var(--ink-mute)", padding: "14px 0", textAlign: "center" }}>まだアングルがありません。視点を決めて保存してください。</div>`}

  <div style=${{ display: "flex", flexDirection: "column", gap: 6 }}>
    ${angles.map((a) => {
      const sel = selected.has(a.id);
      return html`<div key=${a.id} style=${{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, background: sel ? "var(--accent-dim)" : "var(--panel-2)", border: `1px solid ${sel ? "var(--accent)" : "var(--line)"}`, transition: "all .12s" }}>
        <input type="checkbox" checked=${sel} onChange=${() => toggleSelect(a.id)} title="一括書き出しに含める" />
        <button onClick=${() => onApply(a)} title="この視点に移動" style=${{ flex: 1, textAlign: "left", fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${a.name}</button>
        <span class="mono" style=${{ fontSize: 9.5, color: "var(--ink-mute)" }}>fov ${Math.round(a.fov)}</span>
        <button onClick=${() => onApply(a)} title="移動" style=${{ color: "var(--ink-dim)", padding: 2 }}><${Icon} name="eye" size=${13} /></button>
        <button onClick=${() => onDelete(a.id)} title="削除" style=${{ color: "var(--ink-mute)", padding: 2 }}><${Icon} name="trash" size=${13} /></button>
      </div>`;
    })}
  </div>

  <div style=${{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)", display: "flex", gap: 6 }}>
    <${Btn} icon="download" onClick=${onExport} disabled=${!angles.length} style=${{ flex: 1 }}>JSON書き出し<//>
    <label style=${{ flex: 1 }}>
      <input type="file" accept=".json,application/json" style=${{ display: "none" }} onChange=${(e) => e.target.files[0] && onImport(e.target.files[0])} />
      <div style=${{ padding: "7px 11px", borderRadius: 6, fontSize: 12, textAlign: "center", color: "var(--ink-dim)", border: "1px solid var(--line-2)", cursor: "pointer" }}>JSON読込</div>
    </label>
  </div>
  <div class="cap" style=${{ marginTop: 8, fontSize: 9.5, textTransform: "none", letterSpacing: 0, lineHeight: 1.6 }}>チェックしたアングルは「静止画」タブから選択解像度でZIP一括書き出しできます。</div>
`;

// ---------- resolution picker (shared) ----------
const ResPicker = ({ presets, presetIdx, setPresetIdx, useCustom, setUseCustom, w, setW, h, setH, minLong }) => html`
  <div>
    <div style=${{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
      ${presets.map((p, i) => {
        const active = !useCustom && presetIdx === i;
        const disabled = minLong ? Math.max(p.w, p.h) < minLong : false;
        return html`<button key=${p.label} disabled=${disabled} onClick=${() => { setUseCustom(false); setPresetIdx(i); }}
          style=${{ padding: "8px 6px", borderRadius: 6, fontSize: 11.5, fontFamily: "JetBrains Mono, monospace", opacity: disabled ? 0.35 : 1, cursor: disabled ? "not-allowed" : "pointer", background: active ? "var(--accent-dim)" : "var(--panel-2)", border: `1px solid ${active ? "var(--accent)" : "var(--line-2)"}`, color: active ? "var(--accent)" : "var(--ink-dim)", fontWeight: active ? 600 : 500, transition: "all .12s" }}>${p.label}</button>`;
      })}
    </div>
    <div style=${{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
      <label style=${{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
        <input type="checkbox" checked=${useCustom} onChange=${(e) => setUseCustom(e.target.checked)} />
        <span style=${{ fontSize: 12 }}>任意</span>
      </label>
      <input type="number" min="1" value=${w} disabled=${!useCustom} onInput=${(e) => setW(parseInt(e.target.value) || 0)} style=${{ width: 64, opacity: useCustom ? 1 : 0.4 }} />
      <span class="mono" style=${{ color: "var(--ink-mute)" }}>×</span>
      <input type="number" min="1" value=${h} disabled=${!useCustom} onInput=${(e) => setH(parseInt(e.target.value) || 0)} style=${{ width: 64, opacity: useCustom ? 1 : 0.4 }} />
    </div>
  </div>`;

// ---------- Still tab ----------
const StillTab = ({ stillPreset, setStillPreset, useCustom, setUseCustom, customW, setCustomW, customH, setCustomH, imgFormat, setImgFormat, amazon, stillTooSmall, modelReady, selectedCount, onExport, onBatch, onFit }) => html`
  ${amazon && html`<div style=${{ marginBottom: 10, padding: "8px 12px", borderRadius: 8, background: "var(--amazon-dim)", border: "1px solid var(--amazon)", fontSize: 11.5, color: "var(--amazon)", lineHeight: 1.6 }}>
    Amazon商品画像モード: 純白背景 + JPEG(品質0.92)。長辺1600px未満は選べません。
  </div>`}

  <${SubHeader}>出力解像度<//>
  <${ResPicker} presets=${STILL_PRESETS} presetIdx=${stillPreset} setPresetIdx=${setStillPreset}
    useCustom=${useCustom} setUseCustom=${setUseCustom} w=${customW} setW=${setCustomW} h=${customH} setH=${setCustomH}
    minLong=${amazon ? 1600 : 0} />

  ${!amazon && html`
    <${SubHeader}>形式<//>
    <${Segment} value=${imgFormat} onChange=${setImgFormat} options=${[
      { value: "png", label: "PNG" }, { value: "png-alpha", label: "PNG透過" }, { value: "jpg", label: "JPG" },
    ]} />`}
  ${amazon && html`<div style=${{ marginTop: 8, fontSize: 11.5, color: "var(--ink-dim)" }}>形式: <span class="mono" style=${{ color: "var(--amazon)" }}>JPEG q0.92</span></div>`}

  ${amazon && html`<div style=${{ marginTop: 12 }}>
    <${Btn} kind="amazon" icon="frame" disabled=${!modelReady} onClick=${onFit} style=${{ width: "100%" }}>長辺を85%にフィット<//>
  </div>`}

  ${stillTooSmall && html`<div style=${{ marginTop: 8, fontSize: 11.5, color: "var(--warn)" }}>長辺が1600px未満です。解像度を上げてください。</div>`}

  <div style=${{ marginTop: 12 }}>
    <${Btn} kind=${amazon ? "amazon" : "primary"} icon="cam" disabled=${!modelReady || stillTooSmall} onClick=${onExport} style=${{ width: "100%" }}>現在のアングルを書き出す<//>
  </div>

  <div style=${{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
    <${SubHeader}>一括書き出し (ZIP)<//>
    <div style=${{ fontSize: 11.5, color: "var(--ink-dim)", marginBottom: 8, lineHeight: 1.6 }}>
      「アングル」タブで選択した ${selectedCount} 件を、上記の解像度・形式で連続書き出ししてZIPにまとめます。
    </div>
    <${Btn} kind="solid" icon="layers" disabled=${!modelReady || selectedCount === 0 || stillTooSmall} onClick=${onBatch} style=${{ width: "100%" }}>${selectedCount ? `選択した${selectedCount}件をZIP書き出し` : "アングルを選択してください"}<//>
  </div>
`;

// ---------- Motion tab ----------
const MotionTab = ({ videoPreset, setVideoPreset, vUseCustom, setVUseCustom, vCustomW, setVCustomW, vCustomH, setVCustomH, videoFormat, setVideoFormat, camWork, setCamWork, orbitDeg, setOrbitDeg, videoFps, setVideoFps, videoDur, setVideoDur, videoSecs, setVideoSecs, spinSpeed, setSpinSpeed, spinDir, setSpinDir, mode, setMode, playing, setPlaying, axis, setAxis, modelReady, onExport }) => html`
  <${SubHeader}>ビューポートプレビュー<//>
  <div style=${{ background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px" }}>
    <${Row} label="自動回転" hint="画面のみ">
      <${Segment} small value=${mode} onChange=${setMode} options=${[
        { value: "manual", label: "手動" }, { value: "auto", label: "自動" },
      ]} />
    <//>
    ${mode === "auto" && html`
      <${Row} label="軸">
        <${Segment} small value=${axis} onChange=${setAxis} options=${[
          { value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" },
        ]} />
      <//>
      <${Row} label="方向">
        <${Segment} small value=${spinDir} onChange=${setSpinDir} options=${[
          { value: 1, label: "時計回り" }, { value: -1, label: "反時計回り" },
        ]} />
      <//>
      <${Row} label="速度">
        <${Slider} value=${spinSpeed} min=${0.1} max=${3} step=${0.05} onChange=${setSpinSpeed} format=${(v) => v.toFixed(2) + "×"} width=${120} />
      <//>
      <div style=${{ marginTop: 6 }}>
        <${Btn} kind=${playing ? "solid" : "primary"} icon=${playing ? "pause" : "play"} onClick=${() => setPlaying(!playing)}>
          ${playing ? "一時停止" : "再生"}
        <//>
      </div>`}
  </div>
  <div class="cap" style=${{ marginTop: 6, fontSize: 9.5, textTransform: "none", letterSpacing: 0 }}>書き出しには影響しません。動画はカメラワークで指定します。</div>

  <div style=${{ marginTop: 14, paddingTop: 4, borderTop: "1px solid var(--line)" }}></div>
  <${SubHeader}>カメラワーク<//>
  <${Segment} value=${camWork} onChange=${setCamWork} options=${[
    { value: "turntable", label: "ターンテーブル" },
    { value: "orbit", label: "オービット" },
    { value: "dolly", label: "ドリーイン" },
    { value: "spin", label: "オブジェクト回転" },
  ]} />
  ${camWork === "orbit" && html`
    <${Row} label="振れ幅" hint="±°">
      <${Slider} value=${orbitDeg} min=${5} max=${90} step=${1} onChange=${setOrbitDeg} unit="°" width=${140} />
    <//>`}
  ${camWork === "spin" && html`
    <${Row} label="方向">
      <${Segment} small value=${spinDir} onChange=${setSpinDir} options=${[{ value: 1, label: "時計回り" }, { value: -1, label: "反時計回り" }]} />
    <//>`}

  <${SubHeader}>出力形式<//>
  <${Segment} value=${videoFormat} onChange=${setVideoFormat} options=${[
    { value: "mp4", label: "MP4" }, { value: "gif", label: "GIF" }, { value: "png", label: "連番PNG" },
  ]} />
  ${videoFormat === "gif" && html`<div class="cap" style=${{ marginTop: 6, fontSize: 9.5, textTransform: "none", letterSpacing: 0 }}>GIFは長辺500px・実効15fpsに自動制限されます。</div>`}
  ${videoFormat === "mp4" && html`<div class="cap" style=${{ marginTop: 6, fontSize: 9.5, textTransform: "none", letterSpacing: 0 }}>WebCodecs (avc1) で決定論的にエンコード。</div>`}

  <${SubHeader}>解像度<//>
  <${ResPicker} presets=${VIDEO_PRESETS} presetIdx=${videoPreset} setPresetIdx=${setVideoPreset}
    useCustom=${vUseCustom} setUseCustom=${setVUseCustom} w=${vCustomW} setW=${setVCustomW} h=${vCustomH} setH=${setVCustomH} minLong=${0} />

  <${SubHeader}>長さ<//>
  <${Segment} small value=${videoDur} onChange=${setVideoDur} options=${[{ value: "1rot", label: "1周" }, { value: "sec", label: "秒数指定" }]} />
  ${videoDur === "sec" && html`
    <${Row} label="秒数">
      <${Slider} value=${videoSecs} min=${1} max=${20} step=${1} onChange=${setVideoSecs} unit=" 秒" width=${150} />
    <//>`}

  <${SubHeader}>フレームレート<//>
  <${Segment} small value=${videoFps} onChange=${setVideoFps} options=${[{ value: 24, label: "24" }, { value: 30, label: "30" }, { value: 60, label: "60" }]} />

  <div style=${{ marginTop: 14 }}>
    <${Btn} kind="primary" icon="video" disabled=${!modelReady} onClick=${onExport} style=${{ width: "100%" }}>${videoFormat === "mp4" ? "MP4を書き出す" : videoFormat === "gif" ? "GIFを書き出す" : "連番PNGを書き出す"}<//>
  </div>
`;

// ---------- Light tab ----------
const LightTab = ({ L, updateL, activePreset, applyPreset, envOn, setEnvOn, envIntensity, setEnvIntensity, amazon }) => html`
  ${amazon && html`<div style=${{ marginBottom: 8, fontSize: 11.5, color: "var(--amazon)" }}>Amazonモードでは「ソフト」ライティングを推奨しています。</div>`}
  <${SubHeader}>プリセット<//>
  <div style=${{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
    ${Object.keys(PRESETS).map((name) => {
      const active = activePreset === name;
      return html`<button key=${name} onClick=${() => applyPreset(name)}
        onMouseEnter=${(e) => { if (!active) e.currentTarget.style.borderColor = "var(--accent)"; }}
        onMouseLeave=${(e) => { if (!active) e.currentTarget.style.borderColor = "var(--line-2)"; }}
        style=${{ padding: "10px 10px", borderRadius: 6, fontSize: 12, background: active ? "var(--accent-dim)" : "var(--panel-2)", border: `1px solid ${active ? "var(--accent)" : "var(--line-2)"}`, color: active ? "var(--accent)" : "var(--ink)", fontWeight: active ? 600 : 500, display: "flex", alignItems: "center", gap: 8, transition: "all .12s ease-out" }}>
        <${PresetThumb} name=${name} /> ${name}
      </button>`;
    })}
  </div>

  <${SubHeader}>HDRI 環境光<//>
  <div style=${{ display: "flex", alignItems: "center", gap: 10, background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px" }}>
    <label style=${{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1 }}>
      <input type="checkbox" checked=${envOn} onChange=${(e) => setEnvOn(e.target.checked)} />
      <span style=${{ fontSize: 12 }}>スタジオHDRIを使用</span>
    </label>
  </div>
  ${envOn && html`<div style=${{ paddingLeft: 8, marginTop: 4 }}>
    <${Row} label="強度"><${Slider} value=${envIntensity} min=${0} max=${2} step=${0.05} onChange=${setEnvIntensity} format=${(v) => v.toFixed(2)} width=${150} /><//>
  </div>`}

  <${SubHeader}>環境光<//>
  <${LightBlock} label="環境光" data=${L.ambient} onChange=${(v) => updateL("ambient", v)} showDir=${false} />
  <${SubHeader}>ディレクショナル<//>
  <${LightBlock} label="メインライト" data=${L.key} onChange=${(v) => updateL("key", v)} />
  <${LightBlock} label="フィルライト" data=${L.fill} onChange=${(v) => updateL("fill", v)} />
  <${LightBlock} label="リムライト" data=${L.rim} onChange=${(v) => updateL("rim", v)} />
`;

const PresetThumb = ({ name }) => {
  const map = { "スタジオ": ["#fff", "#cfe6ff", "#ffe4b8"], "アウトドア": ["#fff3dc", "#bfd4ff", "#ffffff"], "ドラマチック": ["#ffe9c4", "#2a3a55", "#ffaa66"], "ソフト": ["#ffffff", "#ffffff", "#ffffff"] };
  const [a, b, c] = map[name] || ["#fff", "#fff", "#fff"];
  const bg = name === "ドラマチック" ? "#0b0c0f" : "#1b1e24";
  return html`<svg width="22" height="22" viewBox="0 0 22 22" style=${{ flexShrink: 0 }}>
    <rect width="22" height="22" rx="4" fill=${bg} />
    <circle cx="11" cy="12" r="5" fill=${a} opacity="0.2" />
    <circle cx="14" cy="10" r="2.5" fill=${a} />
    <circle cx="7" cy="13" r="2" fill=${b} opacity="0.75" />
    <circle cx="15" cy="14" r="1.5" fill=${c} opacity="0.85" />
  </svg>`;
};

const CapturePreview = ({ cap, onClear }) => html`
  <div style=${{ marginTop: 16, padding: 12, borderRadius: 10, background: "var(--panel-2)", border: "1px solid var(--accent)", animation: "fadein .2s ease-out" }}>
    <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
      <div style=${{ display: "flex", alignItems: "center", gap: 6, color: "var(--accent)" }}>
        <${Icon} name="check" size=${13} /><div style=${{ fontSize: 12, fontWeight: 600 }}>書き出し完了</div>
      </div>
      <button onClick=${onClear} style=${{ color: "var(--ink-mute)", padding: 2 }}><${Icon} name="close" size=${12} /></button>
    </div>
    <div class="checker" style=${{ width: "100%", height: 160, background: "#0b0c0f", borderRadius: 6, overflow: "hidden", display: "grid", placeItems: "center" }}>
      ${cap.type === "image" ? html`<img src=${cap.url} style=${{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />`
        : cap.type === "video" ? html`<video src=${cap.url} controls autoplay loop muted style=${{ maxWidth: "100%", maxHeight: "100%" }} />`
        : html`<div style=${{ color: "var(--ink-dim)", fontSize: 12, textAlign: "center" }}><${Icon} name="layers" size=${28} /><div style=${{ marginTop: 8 }}>ZIP アーカイブ</div></div>`}
    </div>
    ${cap.note && html`<div class="cap" style=${{ marginTop: 8, fontSize: 9.5, textTransform: "none", letterSpacing: 0, color: "var(--ink-dim)" }}>${cap.note}</div>`}
    <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
      <div class="mono" style=${{ fontSize: 10.5, color: "var(--ink-mute)" }}>${cap.w}×${cap.h}</div>
      <a href=${cap.url} download=${cap.name} style=${{ textDecoration: "none" }}>
        <${Btn} kind="primary" icon="download">ダウンロード<//>
      </a>
    </div>
  </div>`;

const HelpModal = ({ onClose }) => html`
  <div onClick=${onClose} style=${{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 50, animation: "fadein .15s ease-out" }}>
    <div onClick=${(e) => e.stopPropagation()} style=${{ width: 460, maxHeight: "80vh", overflow: "auto", background: "var(--panel)", border: "1px solid var(--line-2)", borderRadius: 12, padding: 20 }}>
      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style=${{ fontSize: 14, fontWeight: 700 }}>ヘルプ</div>
        <button onClick=${onClose} style=${{ color: "var(--ink-mute)" }}><${Icon} name="close" size=${14} /></button>
      </div>
      <div style=${{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.75 }}>
        <p style=${{ margin: "0 0 10px" }}><b style=${{ color: "var(--ink)" }}>GLB Studio</b> は 3Dモデルから高品質なマーケティング素材を書き出すツールです (Chrome専用)。</p>
        <p style=${{ margin: "10px 0 4px", color: "var(--ink)", fontWeight: 600 }}>アングル</p>
        <p style=${{ margin: "0 0 8px" }}>現在の視点を名前付きで保存し、いつでも呼び出せます。チェックしたアングルは静止画タブからZIPで一括書き出しできます。JSONで書き出し/読み込みも可能です。</p>
        <p style=${{ margin: "10px 0 4px", color: "var(--ink)", fontWeight: 600 }}>静止画</p>
        <p style=${{ margin: "0 0 8px" }}>出力解像度を明示指定してオフスクリーンで書き出します (PNG / PNG透過 / JPG)。</p>
        <p style=${{ margin: "10px 0 4px", color: "var(--ink)", fontWeight: 600 }}>モーション</p>
        <p style=${{ margin: "0 0 8px" }}>ターンテーブル / オービット / ドリーイン / オブジェクト回転を、固定解像度で1フレームずつ決定論的にレンダリングして MP4 / GIF / 連番PNG に書き出します。</p>
        <p style=${{ margin: "10px 0 4px", color: "var(--amazon)", fontWeight: 600 }}>Amazon商品画像モード</p>
        <p style=${{ margin: 0 }}>純白(255,255,255)背景を保証。長辺を画面の85%にフィットするボタン付き、JPEG(0.92)・既定2000×2000で書き出します。</p>
      </div>
    </div>
  </div>`;

createRoot(document.getElementById("root")).render(html`<${App} />`);
