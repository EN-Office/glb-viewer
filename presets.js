// presets.js — lighting presets, framing math, camera-angle persistence
import * as THREE from "three";

// ---------- Lighting presets ----------
export const defaultLighting = {
  ambient: { intensity: 0.25, color: "#ffffff" },
  key:     { intensity: 1.6,  color: "#ffffff", az: 45,  el: 40 },
  fill:    { intensity: 0.55, color: "#cfe6ff", az: -60, el: 20 },
  rim:     { intensity: 0.9,  color: "#ffe4b8", az: 170, el: 25 },
};

export const PRESETS = {
  "スタジオ": defaultLighting,
  "アウトドア": {
    ambient: { intensity: 0.55, color: "#eef5ff" },
    key:     { intensity: 1.4,  color: "#fff3dc", az: 30,  el: 55 },
    fill:    { intensity: 0.7,  color: "#bfd4ff", az: -90, el: 30 },
    rim:     { intensity: 0.4,  color: "#ffffff", az: 180, el: 20 },
  },
  "ドラマチック": {
    ambient: { intensity: 0.05, color: "#1a1f2a" },
    key:     { intensity: 2.4,  color: "#ffe9c4", az: 60,  el: 20 },
    fill:    { intensity: 0.12, color: "#2a3a55", az: -80, el: 10 },
    rim:     { intensity: 1.8,  color: "#ffaa66", az: 200, el: 40 },
  },
  "ソフト": {
    ambient: { intensity: 0.55, color: "#ffffff" },
    key:     { intensity: 0.9,  color: "#ffffff", az: 30,  el: 45 },
    fill:    { intensity: 0.7,  color: "#ffffff", az: -45, el: 30 },
    rim:     { intensity: 0.5,  color: "#ffffff", az: 180, el: 30 },
  },
};

// ---------- Framing: fit model so its screen-projected long edge ~= fraction of viewport ----------
// Computes the world-space bounding box of `object`, projects its 8 corners with
// the current camera orientation, and moves the camera along its view direction
// until the projected long edge occupies `fraction` of the frame.
export function fitToFraction(object, camera, controls, { fraction = 0.85, aspect } = {}) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const R = sphere.radius || 1;

  const A = aspect ?? camera.aspect;
  const vFov = (camera.fov * Math.PI) / 180;
  // horizontal fov derived from vertical fov + aspect
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * A);
  // distance so the bounding sphere fits `fraction` of the tighter axis.
  const fitV = R / Math.sin(vFov / 2);
  const fitH = R / Math.sin(hFov / 2);
  const dist = Math.max(fitV, fitH) / fraction;

  const dir = camera.position.clone().sub(controls ? controls.target : center).normalize();
  if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.4, 0.7).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(dist));
  camera.lookAt(center);
  if (controls) { controls.target.copy(center); controls.update(); }
  return { center: center.toArray(), dist };
}

// ---------- Camera angle persistence ----------
const LS_KEY = "glbstudio.angles.v1";

export function loadAngles() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveAngles(angles) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(angles)); } catch {}
}

export function captureAngle(name, camera, controls) {
  return {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
    name: name || "アングル",
    pos: camera.position.toArray(),
    target: controls ? controls.target.toArray() : [0, 0, 0],
    fov: camera.fov,
  };
}

export function applyAngle(angle, camera, controls) {
  camera.position.fromArray(angle.pos);
  if (angle.fov) { camera.fov = angle.fov; camera.updateProjectionMatrix(); }
  const t = new THREE.Vector3().fromArray(angle.target);
  camera.lookAt(t);
  if (controls) { controls.target.copy(t); controls.update(); }
}
